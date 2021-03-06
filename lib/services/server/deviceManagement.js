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

var async = require('async'),
    apply = async.apply,
    coapUtils = require('./coapUtils'),
    errors = require('../../errors'),
    registry,
    logger = require('logops'),
    context = {
        op: 'LWM2MLib.DeviceManagement'
    };

/**
 * Execute a read operation for the selected resource, identified following the LWTM2M conventions by its: deviceId,
 * objectType, objectId and resourceId.
 */
function read(deviceId, objectType, objectId, resourceId, callback) {
    function createReadRequest(obj, callback) {
        var request = {
            host: obj.address,
            port: 5683,
            method: 'GET',
            pathname: '/' + objectType + '/' + objectId + '/' + resourceId
        };

        callback(null, request);
    }

    logger.debug(context, 'Reading value from resource /%s/%s/%s in device [%d]',
        objectType, objectId, resourceId, deviceId);

    async.waterfall([
        apply(registry.get, deviceId),
        createReadRequest,
        coapUtils.sendRequest,
        coapUtils.generateProcessResponse(objectType, objectId, resourceId, '2.05')
    ], callback);
}

/**
 * Execute a Write operation over the selected resource, identified following the LWTM2M conventions by its: deviceId,
 * objectType, objectId and resourceId, changing its value to the value passed as a parameter.
 */
function write(deviceId, objectType, objectId, resourceId, value, callback) {
    function createUpdateRequest(obj, callback) {
        var request = {
            host: obj.address,
            port: 5683,
            method: 'PUT',
            pathname: '/' + objectType + '/' + objectId + '/' + resourceId,
            payload: value
        };

        callback(null, request);
    }

    function processResponse(res, callback) {
        if (res.code === '2.04') {
            callback(null, res.payload.toString('utf8'));
        } else if (res.code === '4.04') {
            callback(new errors.ObjectNotFound('/' + objectType + '/' + objectId));
        } else {
            callback(new errors.ClientError(res.code));
        }
    }

    logger.debug(context, 'Writting a new value [%s] on resource /%s/%s/%s in device [%d]',
        value, objectType, objectId, resourceId, deviceId);

    async.waterfall([
        apply(registry.get, deviceId),
        createUpdateRequest,
        coapUtils.sendRequest,
        processResponse
    ], callback);
}

function execute(callback) {
    callback(null);

}

/**
 * Write the attributes given as a parameter in the remote resource identified by the Object type and id in the
 * selected device.
 *
 * @param {String} deviceId             ID of the device that holds the resource.
 * @param {String} objectType           ID of the object type of the instance.
 * @param {String} objectId             ID of the instance whose resource will be modified.
 * @param {String} resourceId           ID of the resource to modify.
 * @param {Object} parameters           Object with the parameters to write: each parameter is stored as an attribute.
 */
function writeAttributes(deviceId, objectType, objectId, resourceId, attributes, callback) {
    function createQueryParams(innerCb) {
        var validAttributes = ['pmin', 'pmax', 'gt', 'lt', 'st', 'cancel'],
            result = '?',
            errorList = [];

        for (var i in attributes) {
            if (attributes.hasOwnProperty(i)) {
                if (validAttributes.indexOf(i) >= 0) {
                    result += i + '=' + attributes[i] + '&';
                } else {
                    errorList.push(i);
                }
            }
        }

        if (errorList.length !== 0) {
            innerCb(new errors.UnsupportedAttributes(errorList));
        } else {
            innerCb(null, result);
        }
    }

    function createWriteAttributesRequest(data, innerCb) {
        var request = {
            host: data[0].address,
            port: 5683,
            method: 'PUT'
        };
        if (objectType && objectId && resourceId) {
            request.pathname = '/' + objectType + '/' + objectId + '/' + resourceId + data[1];
        } else if (objectType && objectId) {
            request.pathname = '/' + objectType + '/' + objectId + data[1];
        } else {
            request.pathname = '/' + objectType + data[1];
        }

        innerCb(null, request);
    }

    logger.debug(context, 'Writting new discover attributes on resource /%s/%s/%s in device [%d]',
        objectType, objectId, resourceId, deviceId);
    logger.debug(context, 'The new attributes are:\n%j', attributes);

    async.waterfall([
        apply(async.parallel, [
            apply(registry.get, deviceId),
            createQueryParams
        ]),
        createWriteAttributesRequest,
        coapUtils.sendRequest,
        coapUtils.generateProcessResponse(objectType, objectId, resourceId, '2.04')
    ], callback);
}

/**
 * Execute a discover operation for the selected resource, identified following the LWTM2M conventions by its:
 * deviceId, objectType, objectId and resourceId.
 */
function discover(deviceId, objectType, objectId, resourceId, fullCallback) {
    var pathname,
        trueCallback;

    if (objectId && resourceId && fullCallback) {
        pathname= '/' + objectType + '/' + objectId + '/' + resourceId;
        trueCallback = fullCallback;
    } else if (objectId && resourceId) {
        pathname= '/' + objectType + '/' + objectId;
        trueCallback = resourceId;
    } else {
        pathname= '/' + objectType;
        trueCallback = objectId;
    }

    function createReadRequest(obj, callback) {
        var request = {
            host: obj.address,
            port: 5683,
            method: 'GET',
            pathname: pathname,
            options: {
                'Accept': 'application/link-format'
            }
        };

        callback(null, request);
    }

    logger.debug(context, 'Executing a discover operation on resource /%s/%s/%s in device [%d]',
        objectType, objectId, resourceId, deviceId);

    if (!objectType && !objectId && !resourceId) {
        logger.error(context, 'Method called with wrong number of parameters. Couldn\'t identify callback');
    } else {
        async.waterfall([
            apply(registry.get, deviceId),
            createReadRequest,
            coapUtils.sendRequest,
            coapUtils.generateProcessResponse(objectType, objectId, resourceId, '2.05')
        ], trueCallback);
    }
}

function create(deviceId, objectType, objectId, callback) {
    function createUpdateRequest(obj, callback) {
        var request = {
            host: obj.address,
            port: 5683,
            method: 'POST',
            pathname: '/' + objectType + '/' + objectId
        };

        callback(null, request);
    }

    logger.debug(context, 'Creating a new instance of object type [%s] in the device [%d] with instance id [%s]',
        objectType, deviceId, objectId);

    async.waterfall([
        apply(registry.get, deviceId),
        createUpdateRequest,
        coapUtils.sendRequest,
        coapUtils.generateProcessResponse(objectType, objectId, null, '2.01')
    ], callback);
}

function remove(deviceId, objectType, objectId, callback) {
    callback(null);
}

function init(deviceRegistry) {
    registry = deviceRegistry;
}

exports.read = read;
exports.write = write;
exports.execute = execute;
exports.writeAttributes = writeAttributes;
exports.discover = discover;
exports.create = create;
exports.remove = remove;
exports.init = init;
