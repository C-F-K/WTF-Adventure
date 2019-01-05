import fs from 'fs';
import _ from 'underscore';
import ShutdownHook from 'shutdown-hook';
import Log from 'log';
import config from '../config.json';
import MySQL from './database/mysql';
import WebSocket from './network/websocket';
import Parser from './util/parser';
import Bot from '../../tools/bot/bot';
import Utils from './util/utils';
import World from './game/world';

let allowConnections = false;
const worlds = [];
let database;
let worldsCreated = 0;

const log = new Log(
  config.worlds > 1 ? 'notice' : config.debugLevel,
  config.localDebug ? fs.createWriteStream('runtime.log') : null,
);

function loadParser() {
  Parser();
}

function saveAll() {
  _.each(worlds, (world) => {
    world.saveAll();
  });

  const plural = worlds.length > 1;

  log.notice(
    `Saved players for ${worlds.length} world${plural ? 's' : ''}.`,
  );
}

function allWorldsCreated() {
  log.notice(
    `Finished creating ${
      worlds.length
    } world${
      worlds.length > 1 ? 's' : ''
    }!`,
  );
  allowConnections = true;

  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  log.notice(`Connect locally via http://${host}:${config.port}`);
}

function onWorldLoad() {
  worldsCreated += 1;
  if (worldsCreated === worlds.length) {
    allWorldsCreated();
  }
}

function initializeWorlds() {
  for (const worldId in worlds) {
    if (worlds.hasOwnProperty(worldId)) {
      worlds[worldId].load(onWorldLoad);
    }
  }
}

function getPopulations() {
  const counts = [];

  for (const index in worlds) {
    if (worlds.hasOwnProperty(index)) {
      counts.push(worlds[index].getPopulation());
    }
  }

  return counts;
}

function Main() {
  log.notice(`Initializing ${config.name} game engine...`);

  const shutdownHook = new ShutdownHook();
  const stdin = process.openStdin();
  const webSocket = new WebSocket.Server(config.host, config.port, config.gver);

  if (!config.offlineMode) {
    database = new MySQL(
      config.mysqlHost,
      config.mysqlPort,
      config.mysqlUser,
      config.mysqlPassword,
      config.mysqlDatabase,
    );
  }

  webSocket.onConnect((connection) => {
    if (!allowConnections) {
      connection.sendUTF8('disallowed');
      connection.close();
    }

    let world;

    for (let i = 0; i < worlds.length; i += 1) {
      if (worlds[i].playerCount < worlds[i].maxPlayers) {
        world = worlds[i];
        break;
      }
    }

    if (world) world.playerConnectCallback(connection);
    else {
      log.info('Worlds are currently full, closing...');

      connection.sendUTF8('full');
      connection.close();
    }
  });

  setTimeout(() => {
    for (let i = 0; i < config.worlds; i += 1) {
      worlds.push(new World(i + 1, webSocket, database));
    }

    loadParser();
    initializeWorlds();
  }, 200);

  webSocket.onRequestStatus(() => JSON.stringify(getPopulations()));

  webSocket.onError(() => {
    log.notice('Web Socket has encountered an error.');
  });

  /**
   * We want to generate worlds after the socket
   * has finished initializing.
   */
  process.on('SIGINT', () => {
    shutdownHook.register();
  });

  process.on('SIGQUIT', () => {
    shutdownHook.register();
  });

  shutdownHook.on('ShutdownStarted', () => {
    saveAll();
  });

  stdin.addListener('data', (data) => {
    /**
     * We have to cleanse the raw message because of the \n
     */
    const message = data.toString().replace(/(\r\n|\n|\r)/gm, '');
    const type = message.charAt(0);

    if (type !== '/') {
      return;
    }

    const blocks = message.substring(1).split(' ');
    const command = blocks.shift();

    if (!command) {
      return;
    }

    switch (command) {
      case 'stop':
        log.info('Safely shutting down the server...');
        saveAll();
        process.exit();
        break;

      case 'saveall':
        saveAll();
        break;

      case 'alter':
        if (blocks.length !== 3) {
          log.error('Invalid command format. /alter [database] [table] [type]');
          return;
        }

        if (!database) {
          log.error(
            `The database server is not available for this instance of ${
              config.name
            }.`,
          );
          log.error(
            'Ensure that the database is enabled in the server configuration.',
          );
          return;
        }

        const db = blocks.shift(); // eslint-disable-line
        const table = blocks.shift(); // eslint-disable-line
        const dType = blocks.shift(); // eslint-disable-line

        database.alter(db, table, dType);
        break;

      case 'bot':
        let count = parseInt(blocks.shift(), 10); // eslint-disable-line

        if (!count) {
          count = 1;
        }

        Bot(worlds[0], count);
        break;

      case 'test':
        Utils.test();
        break;
      default:
        break;
    }
  });
}

Main();
