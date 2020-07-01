/* jshint node: true */
'use strict';

const Ziee = require('ziee'),
      Endpoint = require('./endpoint');

class Device {
    constructor(keystore, devInfo, shepherd){
        // devInfo = { type, ieeeAddr, nwkAddr, manufId, manufName, powerSource, modelId, epList }
        if(!keystore) throw new Error("Keystore must be provided")
        
        this.shepherd = shepherd
        this._keystore = keystore
        this._devInfo = devInfo
        
        this.joinTime = null;
        this._endpoints = {}        // key is epId in number, { epId: epInst, epId: epInst, ... }

        this._initalizeEndpoints(devInfo)
    }

    get id() { return this.ieeeAddr }
    get type() { return this._devInfo.type; }
    get ieeeAddr() { return this._devInfo.ieeeAddr; }
    get nwkAddr() { return this._devInfo.nwkAddr; }
    get manufId() { return this._devInfo.manufId; }
    get manufName() { return this._devInfo.manufName; }
    get powerSource() { return this._devInfo.powerSource; }
    get modelId() { return this._devInfo.modelId; }
    get status() { return this._devInfo.status || "offline"; }
    get capabilities() { return this._devInfo.capabilities; }
    get incomplete() { return !this.complete }
    get complete() { return this._devInfo.complete }

    get epList() {
        const ret = []
        for(const epId in this._endpoints){
            ret.push(parseInt(epId))
        }
        return ret
    }

    get endpoints(){
        const ret = {}
        for(const e in this._endpoints){
            const v = this._endpoints[e]
            if(v) ret[e] = v
        }
        return ret
    }


    set endpoints(value){
        // add new
        const existingKeys = Object.keys(value)
        for(const epId in value){
            const e = value[epId]
            if(e === null){
                if(!this._endpoints[epId]) this._endpoints[epId] = e
            }else{
                if(!(e instanceof Endpoint)){
                    throw new Error(`Endpoint proided of incorrect instance (${e})`)
                }
                this._endpoints[epId] = e
            }
        }

        // clear old
        for(const epId of existingKeys){
            if(value[epId] === undefined) delete this._endpoints[epId]
        }
    }
    
    getEndpointList(){
        const ret = []
        for(const e in this._endpoints){
            const v = this._endpoints[e]
            if(v) ret.push(v)
        }
        return ret
    }


    dumpEps(){
        const dumpOfEps = {};
        for(const epId in this._endpoints){
            const ep = this._endpoints[epId]
            if(ep){
                dumpOfEps[epId] = ep.dump()
            }else{
                dumpOfEps[epId] = null
            }
        }

        return dumpOfEps
    }

    dump(){
        const dumpOfEps = this.dumpEps()
        return {
            _id: this.ieeeAddr,
            type: this.type,
            ieeeAddr: this.ieeeAddr,
            nwkAddr: this.nwkAddr,
            manufId: this.manufId,
            manufName: this.manufName,
            powerSource: this.powerSource,
            modelId: this.modelId,
            status: this.status,
            joinTime: this.joinTime,
            endpoints: dumpOfEps,
            capabilities: this.capabilities,
            complete: this.complete
        };
    }

    getEndpoint (epId) {
        return this.endpoints[epId];
    }
    
    getIeeeAddr () {
        return this.ieeeAddr;
    }
    
    getNwkAddr () {
        return this.nwkAddr;
    }
    
    getManufId () {
        return this.manufId;
    }
    
    async update (info) {
        const infoKeys = [ 'type', 'ieeeAddr', 'nwkAddr', 'status', 'joinTime', 'manufId', 'manufName', 'modelId', 'powerSource', 'capabilities', 'complete' ]

        for(const key in info) {
            if (infoKeys.includes(key))
                this._devInfo[key] = info[key];
        }

        if(info.endpoints){
            this.endpoints = info.endpoints
        }

        await this._keystore.set(this.id, this.dump())
    }
    async delete(){
        await this._keystore.set(this.id, undefined)
    }
    async insert(){
        await this._keystore.set(this.id, this.dump())
    }

    _endpoint(v,_){
        return new Endpoint(this, v, this.shepherd)
    }

    _initalizeEndpoints(devInfo){
        if(!devInfo.endpoints) return
        for(const k in devInfo.endpoints){
            const v = devInfo.endpoints[k]
            if(v.isEndpoint && v.isEndpoint()){
                this._endpoints[k] = v
            }else{
                var ep = this._endpoints[k] ? this._endpoints[k] : this._endpoint(v, k)
                ep.clusters = new Ziee();
                for(const cId in v.clusters){
                    const c = v.clusters[cId]
                    if(c.dir) ep.clusters.init(cId, 'dir', c.dir);
                    ep.clusters.init(cId, 'attrs', c.attrs, false);
                }
                this._endpoints[k] = ep
            }
        }
    }

    addEndpoint(ep){
        if(!(ep instanceof Endpoint)) {
            throw new Error("ep must be an Endpoint")
        }
        this._endpoints[ep.getEpId()] = ep
    }
    removeEndpoint(epId){
        delete this._endpoints[epId]
    }

    static async get(id, keystore, shepherd){
        const devInfo = await keystore.get(id)
        if(!devInfo) return null
        return new Device(keystore, devInfo, shepherd)
    }
    static async exists(id, keystore){
        const devInfo = await keystore.get(id)
        return !!devInfo;
    }
    static async all(keystore, shepherd){
        const all = await keystore.all()
        const ret = []
        for(const devInfo of all){
            const device = new Device(keystore, devInfo, shepherd)
            ret.push(device)
        }
        return ret
    }
}


module.exports = Device;