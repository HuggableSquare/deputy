import pino from 'pino';
import path from 'node:path';
import { Open } from 'unzipper';
import mime, { Mime } from 'mime';
import poppler from 'poppler-simple';
import { readdir, stat } from 'node:fs/promises';

const comicMime = new Mime({
  'application/vnd.comicbook+zip': ['cbz'],
  'application/vnd.comicbook-rar': ['cbr'],
  'application/pdf': ['pdf']
});

export const logger = pino();
// TODO: make this configurable
const dir = 'books';

export class Entities extends Array {
  findById(id) {
    return this.find((entity) => entity.id === id);
  }

  async init() {
    console.time('init');
    const { dir: dirname, base } = path.parse(dir);
    const index = await new Directory({ name: base, path: dirname }).init();
    this.push(...index.flat());
    console.timeEnd('init');
    return this;
  }
}

class Entity {
  id;
  name;
  parent;
  path;

  async init() {
    const stats = await stat(this.path);
    const { ino, birthtimeMs } = stats;
    this.id = this.parent ? `I${ino}D${birthtimeMs}` : 'index';
    return stats;
  }

  constructor(dirent, parent) {
    this.path = path.join(dirent.path, dirent.name);
    this.parent = parent;
  }
}

class Directory extends Entity {
  isDirectory = true;

  // BUG: this errors if the directory is empty
  getFileForThumbnail() {
    const file = this.children.find(({ isDirectory }) => !isDirectory);
    if (file) return file;
    const directory = this.children.find(({ isDirectory }) => isDirectory);
    return directory.getFileForThumbnail();
  }

  getThumbnail() {
    const file = this.getFileForThumbnail();
    return file.getThumbnail();
  }

  async #read() {
    const ents = (await readdir(this.path, { withFileTypes: true }))
      .filter((ent) => ent.isDirectory() || ent.name.endsWith('cbz') || ent.name.endsWith('pdf'));

    const entities = await Promise.all(ents.map((ent) => {
      const type = ent.isDirectory() ? Directory : File;
      return new type(ent, this.id).init();
    }));

    return entities
      .flat()
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return b.isDirectory - a.isDirectory;
        }
        // sort volumes before singles
        if (a.name.startsWith('Vol') && !b.name.startsWith('Vol')) {
          return -1;
        }
        return a.path.localeCompare(b.path, undefined, { numeric: true });
      });
  }

  async init() {
    await super.init();
    const entities = await this.#read();
    this.numberOfChildren = entities.filter(({ isDirectory }) => !isDirectory).length;
    this.children = entities.filter(({ parent }) => parent === this.id);
    // if the folder has no children, don't bother putting it in the list
    if (this.numberOfChildren === 0) return [];
    const { imageType } = this.getFileForThumbnail();
    this.imageType = imageType;
    return [this, ...entities];
  }

  constructor(dirent, parent) {
    super(dirent, parent);
    this.name = dirent.name;
  }
}

class File extends Entity {
  isDirectory = false;

  async getImages() {
    if (this.path.endsWith('cbz')) {
      const zip = await Open.file(this.path);
      const entries = zip.files
        .filter((entry) => entry.type === 'File' && !path.basename(entry.path).startsWith('.'))
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
        .map((entry) => ({ type: mime.getType(entry.path), data: entry.buffer }));
      return entries;
    }

    if (this.path.endsWith('pdf')) {
      const document = new poppler.PopplerDocument(this.path);
      return Array.from({ length: document.pageCount }, (_, i) => {
        return {
          type: 'image/jpeg',
          data() {
            const page = document.getPage(i + 1);
            const render = page.renderToBuffer('jpeg', 240);
            return render.data;
          }
        };
      });
    }
  }

  async getImage(index) {
    const images = await this.getImages();
    return images[index];
  }

  getThumbnail() {
    return this.getImage(0);
  }

  async init() {
    const { size } = await super.init();
    this.size = size;

    const images = await this.getImages();
    this.numberOfImages = images.length;
    this.imageType = images[0].type;

    return this;
  }

  constructor(dirent, parent) {
    super(dirent, parent);
    this.name = fileNameFormat(dirent);
    this.fileType = comicMime.getType(this.path);
  }
}

function fileNameFormat(ent) {
  const { name } = path.parse(ent.name);
  return name.replace(path.basename(ent.path), '').trim();
}
