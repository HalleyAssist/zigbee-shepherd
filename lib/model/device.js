/* jshint node: true */
'use strict';

var _ = require('busyman'),
    Ziee = require('ziee'),
    Endpoint = require('./endpoint');

function Device(devInfo) {
    // devInfo = { type, ieeeAddr, nwkAddr, manufId, manufName, powerSource, modelId, epList }

    this._id = null;

    this.type = devInfo.type;
    this.ieeeAddr = devInfo.ieeeAddr;
    this.nwkAddr = devInfo.nwkAddr;
    this.manufId = devInfo.manufId;
    this.manufName = devInfo.manufName;
    this.powerSource = devInfo.powerSource;
    this.modelId = devInfo.modelId;
    this.epList = devInfo.epList;

    this.status = 'offline';    // 'online', 'offline'
    this.joinTime = null;
    this.endpoints = {}        // key is epId in number, { epId: epInst, epId: epInst, ... }
    if(devInfo.endpoints && this.type != "Coordinator"){
        var self = this
        _.forEach(devInfo.endpoints, function(v, k){
            if(v.isEndpoint && v.isEndpoint(true)){
                self.endpoints[k] = v
            }else{
                var ep = new Endpoint(self, v)
                ep.clusters = new Ziee();
                _.forEach(v.clusters, function(c, cid){
                    if(c.dir) ep.clusters.init(cid, 'dir', c.dir);
                    ep.clusters.init(cid, 'attrs', c.attrs, false);
                });
                self.endpoints[k] = ep
            }
        })
    }
    this.capabilities = devInfo.capabilities;
    this.incomplete = typeof devInfo.incomplete === "undefined" ? true : devInfo.incomplete;
}

Device.prototype.dump = function () {
    var dumpOfEps = {};

    _.forEach(this.endpoints, function (ep, epId) {
        dumpOfEps[epId] = ep.dump();
    });

    return {
        id: this._id,
        type: this.type,
        ieeeAddr: this.ieeeAddr,
        nwkAddr: this.nwkAddr,
        manufId: this.manufId,
        manufName: this.manufName,
        powerSource: this.powerSource,
        modelId: this.modelId,
        epList: _.cloneDeep(this.epList),
        status: this.status,
        joinTime: this.joinTime,
        endpoints: dumpOfEps,
        capabilities: this.capabilities,
        incomplete: this.incomplete
    };
};

Device.prototype.getEndpoint = function (epId) {
    return this.endpoints[epId];
};

Device.prototype.getIeeeAddr = function () {
    return this.ieeeAddr;
};

Device.prototype.getNwkAddr = function () {
    return this.nwkAddr;
};

Device.prototype.getManufId = function () {
    return this.manufId;
};

Device.prototype.update = function (info) {
    var self = this,
        infoKeys = [ 'type', 'endpoints', 'ieeeAddr', 'nwkAddr','manufId', 'epList', 'status', 'joinTime', 'manufName', 'modelId', 'powerSource', 'capabilities', 'incomplete' ];

    _.forEach(info, function (val, key) {
        if (_.includes(infoKeys, key))
            self[key] = val;
    });
};

Device.prototype._recoverFromRecord = function (rec, shepherd) {
    this._recovered = true;
    this.status = 'offline';
    this._setId(rec.id);

    if(this.type != "Coordinator"){
        _.forEach(this.endpoints, function(v, k){
            shepherd._attachZclMethods(v)
        })
    }

    return this;
};

Device.prototype._setId = function (id) {
    this._id = id;
};

Device.prototype._getId = function () {
    return this._id;
};

module.exports = Device;
