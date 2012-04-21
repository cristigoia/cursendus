var util = require('util'),
    events = require('events'),
    _ = require('underscore'),
    Player = require('./player'),
    Terrain = require('./terrain'),
    Data = require('./data'),
    conf = require('../config'),
    Game,
    commands = {
      move: /^move (N|E|S|W)/,
      cast: /^cast ([a-zA-Z])([1-9][0-9]?)/
    };

Game = function(gameObj, player1Name, player2Name) {
  events.EventEmitter.call(this);

  if (typeof gameObj === 'object') {
    this.id = gameObj.id;
    this.turn = gameObj.turn;
    this.player1 = new Player(gameObj.player1);
    this.player2 = new Player(gameObj.player2);

    this.terrain = new Terrain(gameObj.terrain);

    // :-(
    this.terrain.release(this.player1.position[0], this.player1.position[1]);
    this.terrain.release(this.player2.position[0], this.player2.position[1]);
    this.terrain.occupy(this.player1, this.player1.position[0], this.player1.position[1]);
    this.terrain.occupy(this.player2, this.player2.position[0], this.player2.position[1]);
    return;
  }

  this.id = gameObj;
  this.turn = 1;
  this.player1 = new Player(player1Name);
  this.player2 = new Player(player2Name);
  this.terrain = new Terrain();

  this.player1.skin = 1;
  this.player2.skin = 2;

  // Add players
  var p1Added = this.terrain.occupy(this.player1, 0, 6),
      p2Added = this.terrain.occupy(this.player2,
        conf.terrainDimensions[0]-1,
        conf.terrainDimensions[1]-1);

  if (!p1Added || !p2Added) {
    // TODO: error handling
    console.log('Error: players not added to the map');
  }

  this.player1.position = [0, 6];
  this.player2.position = [conf.terrainDimensions[0]-1,
                           conf.terrainDimensions[1]-1];
};
util.inherits(Game, events.EventEmitter);

Game.configure = function(configuration) {
  _.extend(conf, configuration);
};

Game.getGame = function(id, cb) {
  Data.getGame(id, function(err, dataGame) {
    if (err || !dataGame) {
      return cb(false);
    }
    cb(new Game(dataGame));
  });
};

Game.addGame = function(player1, player2, cb) {
  Data.gameId(function(id) {
    var game = new Game(id, player1, player2);
    console.log('[new game] %s', id);
    console.log('redis: add game...');
    Data.addGame(game, function(val) {
      if (val) {
        console.log('redis: added.');
      } else {
        console.log('redis: error, already exists.');
      }
    });
    return cb(game);
  });
};

Game.prototype.movePlayer = function(player, direction) {
  var oldX = player.position[0],
      oldY = player.position[1],
      x = player.position[0],
      y = player.position[1],
      isOccupied;
  switch (direction) {
    case 'N':
      y--;
      break;
    case 'E':
      x++;
      break;
    case 'S':
      y++;
      break;
    case 'W':
      x--;
      break;
  }

  isOccupied = this.terrain.isOccupied(x, y);
  if (isOccupied instanceof Error || isOccupied) {
    return false;
  }

  this.terrain.release(oldX, oldY);
  this.terrain.occupy(player, x, y);
  player.position = [x, y];

  Data.updateGame(this);
  return true;
}

Game.prototype.castPlayer = function(player, col, line) {
  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
      x = letters.indexOf(col.toUpperCase()),
      y = line-1,
      isOccupied,
      other;

  isOccupied = this.terrain.isOccupied(x, y);
  if (x === -1 || isOccupied instanceof Error) {
    return false;
  }

  console.log('almost...')

  other = this.getOtherPlayer(player);
  console.log(other, isOccupied, this.terrain.map[y][x].occupied, other);

  if (!isOccupied || this.terrain.map[y][x].occupied !== other) {
    return false;
  }

  console.log('yeusssssssss!!!!')

  other.health -= 5;
  Data.updateGame(this);
  return true;
}

Game.prototype.getPlayerById = function(id) {
  if (this.player1.email === id) {
    return this.player1;
  } else if (this.player2.email === id) {
    return this.player2;
  } else {
    return false;
  }
};

Game.prototype.getOtherPlayer = function(player) {
  if (this.player1 === player) {
    return this.player2;
  } else if (this.player2 === player) {
    return this.player1;
  }
  return false;
};

Game.prototype.command = function(player, commandStr) {
  var self = this, command, commandValue, player;

  if (player !== self.player1 && player !== self.player2) {
    console.log('[PLAYER DOES NOT EXISTS] %s', player.email);
    return false;
  }

  for (var i in commands) {
    if (commands.hasOwnProperty(i) && commands[i].test(commandStr)) {
      command = i;
      break;
    }
  }

  if (!command) {
    console.log('[COMMAND DOES NOT EXISTS] %s: %s', player.email, commandStr);
    return false;
  }

  commandValue = commandStr.match(commands[command]);

  console.log('[COMMAND] %s: %s', player.email, command);

  switch (command) {
    case 'move':
      player.waitActions.move = commandValue[1];
      break;
    case 'cast':
      player.waitActions.cast = [commandValue[1], commandValue[2]];
      break;
  }
};

Game.prototype.commandsEnd = function(player) {
  if (player !== this.player1 && player !== this.player2) {
    console.log('[PLAYER DOES NOT EXISTS] %s', player.email);
    return false;
  }
  player.wait = true;
  console.log('[commands end: %s]', player.email);
  if (this.getOtherPlayer(player).wait) {
    this.turnEnd();
  }

  Data.updateGame(this);
};

Game.prototype.turnEnd = function() {
  var self = this;
  console.log('end of turn.');

  // Move
  _.each([this.player1, this.player2], function(player) {
    if (player.waitActions.move && self.movePlayer(player, player.waitActions.move)) {
      console.log('MOVE OK!');
    }
  });

  // Cast
  _.each([this.player1, this.player2], function(player) {
    if (player.waitActions.cast && self.castPlayer(player, player.waitActions.cast[0], player.waitActions.cast[1])) {
      console.log('CAST OK!');
    }
  });

  // Reset
  _.each([this.player1, this.player2], function(player) {
    player.waitActions = {};
    player.wait = false;
  });

  this.turn++;
};

module.exports = Game;