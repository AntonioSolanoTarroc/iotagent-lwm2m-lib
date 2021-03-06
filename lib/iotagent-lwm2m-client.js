/*
 * Copyright 2014 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of iotagent-lwm2m-lib
 *
 * iotagent-lwm2m-lib is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * iotagent-lwm2m-lib is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with iotagent-lwm2m-lib.
 * If not, seehttp://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::[contacto@tid.es]
 */

'use strict';

var objRegistry = require('./services/client/objectRegistry'),
    coap = require('coap'),
    errors = require('./errors'),
    async = require('async'),
    apply = async.apply,
    readService = require('./services/client/read'),
    coapRouter = require('./services/coapRouter'),
    Readable = require('stream').Readable,
    logger = require('logops'),
    config = require('../config'),
    context = {
        op: 'LWM2MLib.Client'
    };

/**
 * Load the internal handlers for each kind of operation. Each handler is implemented in a separated module. This
 * module will be, in time, in charge of executing the user handler for that operation with all the data extracted
 * from the request (and completed with internal data if needed).
 *
 * @param {Object} serverInfo      Object containing all the information of the current server.
 */
function loadHandlers(serverInfo) {
    serverInfo.handlers = {
        write: {
            lib: require('./services/client/write').handle,
            user: coapRouter.defaultHandler
        },
        read: {
            lib: readService.handle,
            user: coapRouter.defaultHandler
        }
    };
}

/**
 * Load the tables of available routes. For each route, the method, a regexp for the path and the name of the operation
 * is indicated (the name of the operation will be used to select the internal and user handlers to execute for each
 * route).
 *
 * @param {Object} serverInfo      Object containing all the information of the current server.
 */
function loadRoutes(serverInfo) {
    serverInfo.routes = [
        ['PUT', /(\/\d+)+/, 'write'],
        ['GET', /(\/\d+)+/, 'read']
    ];
}

function startListener(host, port, callback) {
    coapRouter.start(config.client, function (error, serverInfo) {
        if (error) {
            logger.error(context, 'Failed to start COAP Router for client.');

            callback(error);
        } else {
            logger.debug(context, 'COAP Router started successfully');

            var deviceInformation = {
                currentHost: host,
                currentPort: port,
                location: '',
                serverInfo: serverInfo
            };

            loadHandlers(deviceInformation.serverInfo);
            loadRoutes(deviceInformation.serverInfo);

            callback(null, deviceInformation);
        }
    });
}

function createRegisterResponseHandler(deviceInformation, callback) {
    return function responseHandler(res) {
        if (res.code === '2.01') {
            logger.debug(context, 'Registration succeeded to host [%s] and port [%s]',
                deviceInformation.host, deviceInformation.port);

            for (var i = 0; i < res.options.length; i++) {
                if (res.options[i].name === 'Location-Path') {
                    deviceInformation.location = res.options[i].value;
                }
            }

            callback(null, deviceInformation);
        } else {
            logger.error(context, 'Registration failed with code: ' + res.code);
            callback(new errors.RegistrationFailed(res.code));
        }
    };
}

/**
 * Creates a COAP Text representation of the objects passed as a parameter.
 *
 * @param {Array} objects       Array containing LWM2M Object instances.
 */
function generatePayload(objects, innerCallback) {
    var result = objects.reduce(function(previous, current, index, array) {
        var result = previous + '<' + current.objectUri + '>';

        if (index !== array.length -1) {
            result += ',';
        }

        return result;
    }, '');

    logger.debug(context, 'Object list generated:\n%s', objects);

    innerCallback(null, result);
}

/**
 * Register the client in the Lightweight M2M Server in the seleted host and port, with the given endpoint name. If the
 * registration is successful, a deviceInformation object is returned with the host and port of the connected server
 * and the device location in that server (usually with the form '/rd/<deviceId>').
 *
 * @param {String} host                  Host of the LWTM2M Server
 * @param {String} port                  Port of the LWTM2M Server
 * @param {String} url                   URL of the LWTM2M Server (optional)
 * @param {String} endpointName          Name the client will be registered under
 */
function register(host, port, url, endpointName, callback) {
    var rs = new Readable(),
        errorEmitted = false,
        creationRequest =  {
            host: host,
            port: port,
            method: 'POST',
            pathname: ((url)? url : '') + '/rd',
            query: 'ep=' +  endpointName + '&lt=' + config.client.lifetime + '&lwm2m=' + config.client.version + '&b=U'
        },
        req = coap.request(creationRequest);

    if (config.logLevel) {
        logger.setLevel(config.client.logLevel);
    }

    function sendRequest(payload, innerCallback) {
        logger.debug(context, 'Sending registration request');

        rs.push(payload);
        rs.push(null);
        rs.pipe(req);

        innerCallback(null);
    }

    function registerResponseListener(deviceInformation, innerCallback) {
        req.on('response', createRegisterResponseHandler(deviceInformation, callback));

        innerCallback();
    }

    startListener(host, port, function (error, deviceInformation) {
        async.waterfall([
            apply(registerResponseListener, deviceInformation),
            objRegistry.list,
            generatePayload,
            sendRequest
        ]);

        req.on('error', function (error) {
            logger.error(context, 'Registration response finished with an error:\n%s', error);

            coapRouter.stop(deviceInformation.serverInfo, function (error) {
                logger.error('COAP Router stopped with result: ' + error);
            });

            if (!errorEmitted) {
                errorEmitted = true;
                callback(new errors.ServerNotFound(host + ':' + port));
            }
        });
    });
}

/**
 * Unregisters the client from the given server.
 *
 * @param {Object} deviceInformation        Device information object retrieved during the connection
 */
function unregister(deviceInformation, callback) {
    var creationRequest =  {
            host: deviceInformation.currentHost,
            port: deviceInformation.currentPort,
            method: 'DELETE',
            pathname: deviceInformation.location,
            agent: false
        },
        req = coap.request(creationRequest);

    logger.debug(context, 'Unregistration request:\n%s', JSON.stringify(creationRequest, null, 4));

    req.on('response', function(res) {
        logger.debug(context, 'Unregistration response code:\n%s', res.code);

        coapRouter.stop(deviceInformation.serverInfo, callback);
    });

    req.end();
}

function updateRegistration(deviceInformation, callback) {
    var rs = new Readable(),
        creationRequest =  {
            host: deviceInformation.currentHost,
            port: deviceInformation.currentPort,
            method: 'PUT',
            pathname: deviceInformation.location,
            query: 'lt=' + config.client.lifetime + '&lwm2m=' + config.client.version + '&b=U'
        },
        req = coap.request(creationRequest);

    logger.debug(context, 'Update registration request:\n%s', JSON.stringify(creationRequest, null, 4));

    function sendRequest(payload, callback) {
        rs.push(payload);
        rs.push(null);
        rs.pipe(req);
    }

    req.on('response', function(res) {
        logger.debug(context, 'Update registration response code:\n%s', res.code);

        callback(null, deviceInformation);
    });

    async.waterfall([
        objRegistry.list,
        generatePayload,
        sendRequest
    ]);
}

exports.registry = objRegistry;
exports.register = register;
exports.unregister = unregister;
exports.update = updateRegistration;
exports.setHandler = coapRouter.setHandler;
exports.cancelObserver = readService.cancel;
exports.cancellAllObservers = readService.cancelAll;
exports.listObservers = readService.list;


