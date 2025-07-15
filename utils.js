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
    const { dir: parentPath, base: name } = path.parse(dir);
    const stats = await stat(dir);
    const index = await new Directory({ parentPath, name }, stats).load();
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

  init() {
    return this;
  }

  constructor(dirent, stats, parent) {
    this.path = path.join(dirent.parentPath, dirent.name);
    this.parent = parent;

    const { ino, birthtimeMs } = stats;
    this.id = this.parent ? `I${ino}D${birthtimeMs}` : 'index';
  }
}

class Directory extends Entity {
  isDirectory = true;

  async getFileForThumbnail() {
    // find a child file that isn't broken
    for (const child of this.children) {
      if (child.isDirectory) continue;
      const file = await child.init();
      if (file) return file;
    }

    const directory = this.children.find(({ isDirectory }) => isDirectory);
    return directory.getFileForThumbnail();
  }

  async getThumbnail() {
    const file = await this.getFileForThumbnail();
    return file.getThumbnail();
  }

  async #read() {
    const ents = await readdir(this.path, { withFileTypes: true });
    const entities = await Promise.all(ents.map(async (ent) => {
      if (ent.isDirectory()) {
        const stats = await stat(path.join(ent.parentPath, ent.name));
        return new Directory(ent, stats, this.id).load();
      }
      const type = fileTypes.find((type) => path.extname(ent.name) === type.fileExt);
      if (!type) return [];
      const stats = await stat(path.join(ent.parentPath, ent.name));
      return new type(ent, stats, this.id);
    }));

    return entities.flat();
  }

  async getChildren() {
    const children = await Promise.all(this.children.map((child) => child.init()));
    return children.filter((child) => child);
  }

  async init() {
    if (!this.imageType) {
      const file = await this.getFileForThumbnail();
      this.imageType = file.imageType;
    }

    return this;
  }

  async load() {
    const entities = await this.#read();
    this.numberOfChildren = entities.filter(({ isDirectory }) => !isDirectory).length;
    // if the folder has no children, don't bother putting it in the list
    if (this.numberOfChildren === 0) return [];
    this.children = entities
      .filter(({ parent }) => parent === this.id)
      .sort((a, b) => {
        // directories before files
        if (a.isDirectory !== b.isDirectory) {
          return b.isDirectory - a.isDirectory;
        }

        // volumes before singles
        const aIsVol = a.name.startsWith('Vol');
        const bIsVol = b.name.startsWith('Vol');
        if (aIsVol !== bIsVol) return bIsVol - aIsVol;

        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
    this.updated = new Date(Math.max(...this.children.map(({ updated }) => updated)));
    return [this, ...entities];
  }

  constructor(dirent, stats, parent) {
    super(dirent, stats, parent);
    this.name = dirent.name;
  }
}

class File extends Entity {
  isDirectory = false;

  getThumbnail() {
    return this.getImage(0);
  }

  constructor(dirent, stats, parent) {
    super(dirent, stats, parent);
    this.name = fileNameFormat(dirent);

    const { mtime, size } = stats;
    this.size = size;
    this.updated = mtime;
  }
}

class CBZFile extends File {
  static fileExt = '.cbz';
  fileType = 'application/vnd.comicbook+zip';

  async getImages() {
    const zip = await Open.file(this.path);
    return zip.files
      .filter((entry) => {
        return entry.type === 'File' &&
          !path.basename(entry.path).startsWith('.') &&
          mime.getType(entry.path)?.startsWith('image');
      })
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  async getImage(index) {
    const images = await this.getImages();
    const image = images[index];
    return { type: mime.getType(image.path), data: await image.buffer() };
  }

  async init() {
    if (this.isBroken) return;
    if (this.numberOfImages && this.imageType) return this;
    try {
      const images = await this.getImages();
      this.numberOfImages = images.length;
      this.imageType = mime.getType(images[0].path);
      return this;
    } catch (e) {
      this.isBroken = true;
      logger.debug(e, `file failed to initialize: ${this.path}`);
    }
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
      .filter((entry) => {
        return !entry.flags.directory &&
          !path.basename(entry.name).startsWith('.') &&
          mime.getType(entry.name)?.startsWith('image');
      })
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
    if (this.isBroken) return;
    if (this.numberOfImages && this.imageType) return this;
    try {
      const images = await this.getImages();
      this.numberOfImages = images.length;
      this.imageType = mime.getType(images[0].name);
      return this;
    } catch (e) {
      this.isBroken = true;
      logger.debug(e, `file failed to initialize: ${this.path}`);
    }
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

  constructor(dirent, stats, parent) {
    super(dirent, stats, parent);
    this.document = new poppler.PopplerDocument(this.path);
    this.numberOfImages = this.document.pageCount;
  }
}

const fileTypes = [CBZFile, CBRFile, PDFFile];

function fileNameFormat(ent) {
  const { name } = path.parse(ent.name);
  const parent = path.basename(ent.parentPath);
  const str = name.replaceAll(/\(\D*\)/g, '').trim();
  if (str.startsWith(parent)) return str.replace(parent, '').trim();

  const n = parent.match(/^(.+) (\(\d+\))/)?.[1] || parent;
  const rx = new RegExp(`^${n}`);
  return str.replace(rx, '').trim();
}
