import XML from 'xml';
import pino from 'pino-http';
import express from 'express';
import { Entities, logger } from './utils.js';

const app = express();
app.use(pino({ logger }));

const entities = await new Entities().init();

// entire file
app.get('/opds/f/:id', (req, res) => {
  const entity = entities.findById(req.params.id);
  return res.sendFile(entity.path, { root: process.cwd() });
});

// page from file
app.get('/opds/f/:id/:page', async (req, res) => {
  const entity = entities.findById(req.params.id);
  const image = await entity.getImage(req.params.page);
  res.type(image.type);
  return res.send(image.data);
});

// thumbnail
app.get('/opds/t/:id', async (req, res) => {
  const entity = entities.findById(req.params.id);
  const thumb = await entity.getThumbnail();
  res.type(thumb.type);
  return res.send(thumb.data);
});

// directory
app.get('/opds/d/:id', (req, res) => {
  const { children, name, updated } = entities.findById(req.params.id);

  const entries = children.map((entity) => {
    const entry = [
      { id: entity.id },
      { title: entity.name },
      { updated: entity.updated.toISOString() },
      { 
        link: [{
          _attr: {
            type: entity.imageType,
            rel: 'http://opds-spec.org/image/thumbnail',
            href: `/opds/t/${entity.id}`,
          }
        }] 
      },
      { 
        link: [{
          _attr: {
            type: entity.imageType,
            rel: 'http://opds-spec.org/image',
            href: `/opds/t/${entity.id}`,
          }
        }] 
      }
    ];
    if (entity.isDirectory) {
      entry.push(
        {
          link: [{
            _attr: {
              type: 'application/atom+xml; profile=opds-catalog; kind=acquisition',
              rel: 'subsection',
              href: `/opds/d/${entity.id}`,
              'thr:count': entity.numberOfChildren
            }
          }]
        },
        { content: [{ _attr: { type: 'text' } }, `${entity.numberOfChildren} issues`] }
      );
    } else {
      entry.push(
        {
          link: [{
            _attr: {
              type: entity.fileType,
              rel: 'http://opds-spec.org/acquisition',
              href: `/opds/f/${entity.id}`,
              length: entity.size
            }
          }]
        },
        {
          link: [{
            _attr: {
              type: entity.imageType,
              rel: 'http://vaemendis.net/opds-pse/stream',
              href: `/opds/f/${entity.id}/{pageNumber}`,
              'pse:count': entity.numberOfImages
            }
          }]
        }
      );
    }
    return { entry };
  });

  const xml = XML({
    feed: [
      {
        _attr: {
          'xmlns:atom': 'http://www.w3.org/2005/Atom',
          'xmlns:opds': 'http://opds-spec.org/2010/acquisition',
          'xmlns:thr': 'http://purl.org/syndication/thread/1.0',
          'xmlns:pse': 'http://vaemendis.net/opds-pse/ns'
        }
      },
      { id: req.params.id },
      { title: name },
      { author: [ { name: 'deputy' }, { uri: 'https://github.com/huggablesquare/deputy' } ] },
      { updated: updated.toISOString() },
      ...entries
    ]
  });

  res.type('text/xml');
  return res.send(xml);
});

app.listen(4577);
