const assert = require('assert')

const Device = require('../model/device')

class Devstore {
    constructor(keystore, shepherd){
        this._shepherd = shepherd
        this._keystore = keystore
        this._list = []
        this._db = {}
        this._nwkMap = {}
    }

    async refresh(){
        const devices = await Device.all(this._keystore, this._shepherd)
        for(const d of devices){
            this._db[d.addr] = d
            for(const n of d.altNwk){
                const e = this._nwkMap[n]
                if(e && e.nwkAddr === n) continue
                this._nwkMap[n] = d
            }
            this._nwkMap[d.nwkAddr] = d
        }
        this._list = Object.values(devices)
    }

    find(addr){
        // addr: ieeeAddr(String) or nwkAddr(Number)
        assert(typeof addr === 'string' || typeof addr === 'number', 'addr should be a number or a string.')
        
        if(typeof addr === 'string'){
            return this._db[addr]
        }

        return this._nwkMap[addr]
    }
    all(){
        return this._list
    }
}
module.exports = Devstore