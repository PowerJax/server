require('dotenv').config();
require('promise_util');
const http = require('http');
const querystring = require('querystring');
const WebSocket = require('ws');
const Router = require('./server/Router');
const Constants = require('./Constants');
const serializers = require('./serializers');
const webCache = require('./web_cache');
const log = require('./util/logger');
const follow = require('./util/follow');

const server = http.createServer();
const router = new Router(server);
router.cache = webCache;

const routes = require('./routes');

router.use((req, res, next) => {
  req.needsOG = Constants.UA_REGEX.test(req.headers['user-agent']);
  res.header('Content-Security-Policy', [
    'default-src \'self\' s.gus.host www.google-analytics.com cdn.rawgit.com',
    'script-src \'self\' \'nonce-inline\' s.gus.host www.google-analytics.com cdn.rawgit.com',
    'img-src \'self\' www.google-analytics.com',
  ].join(';'));
  res.headers({
    'X-XSS-Protection': '1; mode=block',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (Constants.CORS_ORIGINS.includes(req.headers.origin)) {
    res.headers({
      'Access-Control-Allow-Origin': req.headers.origin,
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
    });
  }

  const [path, query] = req.url.split('?');
  req.url = decodeURIComponent(path) || '/';
  req.query = query ? querystring.parse(query) : {};

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    req.body = Buffer.concat(chunks).toString();
    next();
  });
});

router.get('/', (req, res) => {
  res.header('Content-Type', 'text/html; charset=utf-8');
  webCache.get('index').then((t) => res.end(t));
});

routes.static(router);

if (process.env.CACHE_KEY) {
  router.get(`/${process.env.CACHE_KEY}`, (req, res) => {
    webCache.clear();
    res.end('cache cleared :)');
  });
}

routes.slack(router);

router.get(Constants.API_RE, (req, res) => {
  const version = req.match[1];
  const serializer = serializers.api[`v${version}`] || serializers.api.current;
  if (!serializer) {
    res.status(404).header('Content-Type', 'application/json; charset=utf-8');
    res.end({ message: Constants.SERVER_404_MESSAGE });
    return;
  }

  follow(req.url.replace(/\/api(?:\/v(.+?))?\//, ''))
    .then((output) => {
      res.header('Content-Type', 'application/json; charset=utf-8');
      res.end(serializer(output));
    })
    .catch((err) => {
      res.header('Content-Type', 'application/json; charset=utf-8');
      res.status(500).end({ error: Constants.SERVER_ERR_MESSAGE });
      log(`API/${version}`, err);
    });
});

router.get(/\/.+/, (req, res) => {
  if (req.needsOG) {
    follow(req.url.slice(1))
      .then((output) => {
        res.header('Content-Type', 'text/html; charset=utf-8');
        res.end(serializers.og(output));
      })
      .catch((err) => {
        res.status(500).end(Constants.SERVER_ERR_MESSAGE);
        log('OG', err);
      });
  } else {
    res.header('Content-Type', 'text/html; charset=utf-8');
    webCache.get('spoopy').then((t) => res.end(t));
  }
});

router.get(/.+/, (req, res) => {
  res.status(404).header('Content-Type', 'application/json; charset=utf-8');
  res.end({ message: Constants.SERVER_404_MESSAGE });
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (ws, req) => {
  follow(req.url.slice(1), (link) => {
    ws.send(JSON.stringify(link));
  }).then((o) => {
    ws.send(JSON.stringify(o));
    ws.close();
  });
});

server.listen(Constants.SERVER_PORT);

process.on('unhandledRejection', log);
process.on('uncaughtException', log);
