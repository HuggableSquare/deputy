import pino from 'pino';
import path from 'node:path';
import { Open } from 'unzipper';
import mime, { Mime } from 'mime';
import poppler from 'poppler-simple';
import { createHash } from 'node:crypto';
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

  getChildren(id) {
    if (id === 'index') {
      return this.filter(({ parent }) => parent === id);
    }
    const { children } = this.findById(id);
    return children;
  }

  async init() {
    console.time('init')
    this.push(...await readFolder(dir));
    console.timeEnd('init')
    return this;
  }
}

class Entity {
  id;
  name;
  parent;
  path;

  constructor(dirent) {
    this.path = `${dirent.path}/${dirent.name}`;
    this.id = createId(this.path);
    this.parent = createId(dirent.path);
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

  async init() {
    const entities = await readFolder(this.path);
    entities.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      // sort volumes before singles
      if (a.name.startsWith('Vol') && !b.name.startsWith('Vol')) {
        return -1;
      }
      return a.path.localeCompare(b.path, undefined, { numeric: true });
    });
    this.numberOfChildren = entities.filter((entity) => !entity.isDirectory).length;
    this.children = entities.filter(({ parent }) => parent === this.id);
    // if the folder has no children, don't bother putting it in the list
    if (this.numberOfChildren === 0) return [];
    const { imageType } = this.getFileForThumbnail();
    this.imageType = imageType;
    return [this, ...entities];
  }

  constructor(dirent) {
    super(dirent);
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
    const { size } = await stat(this.path);
    this.size = size;

    const images = await this.getImages();
    this.numberOfImages = images.length;
    this.imageType = images[0].type;

    return this;
  }

  constructor(dirent) {
    super(dirent);
    this.name = fileNameFormat(dirent);
    this.fileType = comicMime.getType(this.path);
  }
}

function createId(string) {
  if (string === dir) return 'index';
  const hash = createHash('sha256');
  return hash.update(string).digest('hex');
}

function fileNameFormat(ent) {
  const { name } = path.parse(ent.name);
  return name.replace(path.basename(ent.path), '').trim();
}

async function readFolder(dir) {
  const ents = (await readdir(dir, { withFileTypes: true }))
    .filter((ent) => ent.isDirectory() || ent.name.endsWith('cbz') || ent.name.endsWith('pdf'));

  const entities = await Promise.all(ents.map((ent) => {
    const type = ent.isDirectory() ? Directory : File;
    return new type(ent).init();
  }));

  return entities.flatMap((entities) => entities);
}
