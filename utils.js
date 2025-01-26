import mime from 'mime';
import pino from 'pino';
import path from 'node:path';
import { Open } from 'unzipper';
import poppler from 'poppler-simple';
import { createExtractorFromData } from 'node-unrar-js';
import { readdir, readFile, stat } from 'node:fs/promises';

export const logger = pino({ level: process.env.PINO_LOG_LEVEL || 'info' });
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
    const ents = await readdir(this.path, { withFileTypes: true });
    const entities = await Promise.all(ents.map((ent) => {
      const type = ent.isDirectory() ? Directory : fileTypes.find((type) => path.extname(ent.name) === type.fileExt);
      if (!type) return [];
      // if initializing a file fails, just exclude it from the list
      return new type(ent, this.id).init().catch(() => {
        logger.debug({ msg: 'file failed to initialize', ent });
        return [];
      });
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
    this.updated = new Date(Math.max(...this.children.map(({ updated }) => updated)));
    return [this, ...entities];
  }

  constructor(dirent, parent) {
    super(dirent, parent);
    this.name = dirent.name;
  }
}

class File extends Entity {
  isDirectory = false;

  getThumbnail() {
    return this.getImage(0);
  }

  async init() {
    const { mtime, size } = await super.init();
    this.size = size;
    this.updated = mtime;
    return this;
  }

  constructor(dirent, parent) {
    super(dirent, parent);
    this.name = fileNameFormat(dirent);
  }
}

class CBZFile extends File {
  static fileExt = '.cbz';
  fileType = 'application/vnd.comicbook+zip';

  async getImages() {
    const zip = await Open.file(this.path);
    return zip.files
      .filter((entry) => entry.type === 'File' && !path.basename(entry.path).startsWith('.'))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  async getImage(index) {
    const images = await this.getImages();
    const image = images[index];
    return { type: mime.getType(image.path), data: await image.buffer() };
  }

  async init() {
    const images = await this.getImages();
    this.numberOfImages = images.length;
    this.imageType = mime.getType(images[0].path);
    return super.init();
  }
}

class CBRFile extends File {
  static fileExt = '.cbr';
  fileType = 'application/vnd.comicbook-rar';

  async getImages() {
    const data = await readFile(this.path);
    const extractor = await createExtractorFromData({ data });
    const list = extractor.getFileList();
    return [...list.fileHeaders]
      .filter((entry) => !entry.flags.directory && !path.basename(entry.name).startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map(({ name }) => ({
        name,
        extract() {
          const extracted = extractor.extract({ files: [name] });
          const files = [...extracted.files].map(({ extraction }) => Buffer.from(extraction));
          return files[0];
        }
      }));
  }

  async getImage(index) {
    const images = await this.getImages();
    const image = images[index];
    return { type: mime.getType(image.name), data: image.extract() };
  }

  async init() {
    const images = await this.getImages();
    this.numberOfImages = images.length;
    this.imageType = mime.getType(images[0].name);
    return super.init();
  }
}

class PDFFile extends File {
  static fileExt = '.pdf';
  fileType = 'application/pdf';
  imageType = 'image/jpeg';

  async getImage(index) {
    const page = this.document.getPage(Number(index) + 1);
    const { data } = await page.renderToBufferAsync('jpeg', 240);
    return { type: 'image/jpeg', data };
  }

  constructor(dirent, parent) {
    super(dirent, parent);
    this.document = new poppler.PopplerDocument(this.path);
    this.numberOfImages = this.document.pageCount;
  }
}

const fileTypes = [CBZFile, CBRFile, PDFFile];

function fileNameFormat(ent) {
  const { name } = path.parse(ent.name);
  return name.replace(path.basename(ent.path), '').trim();
}
