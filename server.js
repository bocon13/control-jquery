/**
 *  Copyright 2014 Nest Labs Inc. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
'use strict';

var SENSOR_PATH = '/tmp/w1_slave';


var express = require('express'),
    session = require('express-session'),
    cookieParser = require('cookie-parser'),
    app = express(),
    passport = require('passport'),
    bodyParser = require('body-parser'),
    NestStrategy = require('passport-nest').Strategy,
    Firebase = require("firebase"),
    fs = require('fs'),
    storage = require('node-persist');

storage.initSync();
storage.setItem('sensorPath', SENSOR_PATH);

/**
  Setup Passport to use the NestStrategy,
  simply pass in the clientID and clientSecret.

  Here we are pulling those in from ENV variables.
*/
passport.use(new NestStrategy({
    clientID: process.env.NEST_ID,
    clientSecret: process.env.NEST_SECRET
  }
));

/**
  No user data is available in the Nest OAuth
  service, just return the empty user object.
*/
passport.serializeUser(function(user, done) {
  done(null, user);
});

/**
  No user data is available in the Nest OAuth
  service, just return the empty user object.
*/
passport.deserializeUser(function(user, done) {
  done(null, user);
});

/**
  Setup the Express app
*/
app.use(cookieParser('cookie_secret_shh')); // Change for production apps
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(session({
  secret: 'session_secret_shh', // Change for production apps
  resave: true,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

/**
  Server our static jQuery app.
*/
app.use(express.static(__dirname + '/app'));
app.use('/bower_components',  express.static(__dirname + '/bower_components'));

/**
  Listen for calls and redirect the user to the Nest OAuth
  URL with the correct parameters.
*/
app.get('/auth/nest', passport.authenticate('nest'));

/**
  Upon return from the Nest OAuth endpoint, grab the user's
  accessToken and set a cookie so jQuery can access, then
  return the user back to the root app.
*/
app.get('/auth/nest/callback',
        passport.authenticate('nest', { }),
        function(req, res) {
          res.cookie('nest_token', req.user.accessToken);
          storage.setItemSync('nestToken', req.user.accessToken)
          res.redirect('/');
        });


function firstChild(object) {
  for(var key in object) {
    console.log(object[key]);
  }
  for(var key in object) {
    return object[key];
  }
}

function getThermostatId(data, structure, name) {
  var therms = data.devices.thermostats
  // TODO filter by structure

  for (var t in therms) {
    if (therms[t].name == name) {
      return t;
    }
  }
}

function readLines(path) {
  try {
    var stat = fs.statSync(path);
    if (!stat.isFile()) {
      console.log(path + ' is not a file');
      return null;
    }
  } catch (e) {
    console.log('file is missing: ' + path);
    console.log(e)
    return null;
  }
  return fs.readFileSync(path, 'utf8').split('\n');
}

function readPiTemp() {
  var sensorPath = storage.getItemSync('sensorPath');
  var data = readLines(sensorPath);
  if (data && data[0].search('YES') > 0) {
    var tempC = data[1].substr(data[1].indexOf('t=') + 2);
    tempC = parseInt(tempC) / 1000.0
    var tempF = tempC * 9.0 / 5.0 + 32.0
    return tempF
  } else {
    return -1;
  }
}

function analyzeTemps(piTemp, nestAmbient, nestTarget) {
  var path = 'devices/thermostats/' + thermostat.device_id + '/target_temperature_f';

  if (piTemp + 1 >= nestAmbient ) {
    console.log('room temp ' + piTemp + ' is near/above ambient '  + nestAmbient);
  } else if (thermostat['hvac_state'] !== 'off') {
    console.log('hvac is currently on');
  } else if (thermostat.is_using_emergency_heat) {
    console.log("Can't adjust target temperature while using emergency heat.");
  } else if (thermostat.hvac_mode === 'heat-cool') {
    console.error("Can't adjust target temperature while in Heat • Cool mode, use target_temperature_high/low instead.");
  } else if (structure.away.indexOf('away') > -1) {
    console.error("Can't adjust target temperature while structure is set to Away or Auto-away.");
  } else { // ok to set target temperature
    var newTemp = nestAmbient + 1;
    console.log('setting new temp: ' + newTemp);
    dataRef.child(path).set(newTemp);
  }
}

var structure, thermostat, dataRef;
function checkTemp() {
  console.log("RING RING RING @ "  + new Date());

  var piTemp = readPiTemp();

  var nestToken = storage.getItemSync('nestToken');
  if (nestToken) {
    dataRef = new Firebase('wss://developer-api.nest.com');
    dataRef.auth(nestToken);

    dataRef.once('value', function (snapshot) {
      var data = snapshot.val();

      var thermostatId = getThermostatId(data, "Mark Twain", "Upstairs");
      console.log(thermostatId);

      // For simplicity, we only care about the first
      // thermostat in the first structure
      structure = firstChild(data.structures),
      thermostat = data.devices.thermostats[thermostatId];
      //console.log(data)

      // TAH-361, device_id does not match the device's path ID
      thermostat.device_id = thermostatId;

      var nestAmbient = thermostat['ambient_temperature_f'];
      var nestTarget = thermostat['target_temperature_f'];

      console.log(thermostat);
      console.log(piTemp + ' ' + nestAmbient + ' ' +  nestTarget)
      analyzeTemps(piTemp, nestAmbient, nestTarget);
    });
  } else {
    console.log("token not set");
  }
}

/**
  Receive alarm timestamps from phone
*/
var timer = null;
app.get('/alarm/:timestamp', function(req, res) {
  if (timer != null) {
    clearTimeout(timer);
  }

  console.log(req.params);
  var timestamp = parseInt(req.params.timestamp);
  if (timestamp > 0) {
    var alarmTime = new Date(timestamp);
    var now = new Date();
    var delta = (alarmTime - now) - (30 * 60 * 1000); // 30 minutes before
    timer = setTimeout(checkTemp, delta);
    console.log(alarmTime + ": setting timer for " + delta + "ms");
  } else {
    console.log('Null timestamp');
  }
  res.send('success\n');
});

/**
  Export the app
*/
module.exports = app;
