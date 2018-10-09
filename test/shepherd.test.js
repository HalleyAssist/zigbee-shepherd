var Q = require('q'),
    fs = require('fs'),
    path = require('path'),
    Zive = require('zive'),
    Ziee = require('ziee'),
    chai = require('chai'),
    sinon = require('sinon'),
    sinonChai = require('sinon-chai'),
    expect = chai.expect;

sinon.test = require('sinon-test')(sinon, {useFakeTimers: false})

var Shepherd = require('../index.js'),
    Coord  = require('../lib/model/coord'),
    Device  = require('../lib/model/device'),
    Endpoint  = require('../lib/model/endpoint');

chai.use(sinonChai);

var coordinator = new Coord({
    type: 0,
    ieeeAddr: '0x00124b00019c2ee9',
    nwkAddr: 0,
    manufId: 10,
    epList: [ 1, 2]
});

var dev1 = new Device({
    type: 1,
    ieeeAddr: '0x00137a00000161f2',
    nwkAddr: 100,
    manufId: 10,
    epList: [ 1 ],
    incomplete: false
});

var zApp = new Zive({ profId: 0x0104, devId: 6 }, new Ziee());

describe('Top Level of Tests', function () {  
    var shepherd;

    before(function (done) {
        var unlink1 = false,
            unlink2 = false;

        fs.stat('./test/database/dev3.db', function (err, stats) {
            if (err) {
                fs.stat('./test/database', function (err, stats) {
                    if (err) {
                        fs.mkdir('./test/database', function () {
                            unlink1 = true;
                            if (unlink1 && unlink2)
                                done();
                        });
                    } else {
                        unlink1 = true;
                        if (unlink1 && unlink2)
                            done();
                    }
                });
            } else if (stats.isFile()) {
                fs.unlink(path.resolve('./test/database/dev3.db'), function () {
                    unlink1 = true;
                    if (unlink1 && unlink2)
                        done();
                });
            }
        });

        fs.stat('./test/database/dev1.db', function (err, stats) {
            if (err) {
                fs.stat('./test/database', function (err, stats) {
                    if (err) {
                        fs.mkdir('./test/database', function () {
                            unlink2 = true;
                            if (unlink1 && unlink2)
                                done();
                        });
                    } else {
                        unlink2 = true;
                        if (unlink1 && unlink2)
                            done();
                    }
                });
            } else if (stats.isFile()) {
                fs.unlink(path.resolve('./test/database/dev1.db'), function () {
                    unlink2 = true;
                    if (unlink1 && unlink2)
                        done();
                });
            }
        });
        
        shepherd = new Shepherd('/dev/ttyUSB0', { dbPath: __dirname + '/database/dev3.db' });
    });

    describe('Constructor Check', function () {
        it('should has all correct members after new', function () {
            expect(shepherd._startTime).to.be.equal(0);
            expect(shepherd._enabled).to.be.false;
            expect(shepherd._zApp).to.be.an('array');
            expect(shepherd.controller).to.be.an('object');
            expect(shepherd.af).to.be.null;
            expect(shepherd._dbPath).to.be.equal(__dirname + '/database/dev3.db');
            expect(shepherd._devbox).to.be.an('object');
        });

        it('should throw if path is not a string', function () {
            expect(function () { return new Shepherd({}, {}); }).to.throw(TypeError);
            expect(function () { return new Shepherd([], {}); }).to.throw(TypeError);
            expect(function () { return new Shepherd(1, {}); }).to.throw(TypeError);
            expect(function () { return new Shepherd(true, {}); }).to.throw(TypeError);
            expect(function () { return new Shepherd(NaN, {}); }).to.throw(TypeError);

            expect(function () { return new Shepherd('xxx'); }).not.to.throw(Error);
        });

        it('should throw if opts is given but not an object', function () {
            expect(function () { return new Shepherd('xxx', []); }).to.throw(TypeError);
            expect(function () { return new Shepherd('xxx', 1); }).to.throw(TypeError);
            expect(function () { return new Shepherd('xxx', true); }).to.throw(TypeError);

            expect(function () { return new Shepherd('xxx', {dbPath: "/tmp/1.db"}); }).not.to.throw(Error);
        });
    });

    describe('Signature Check', function () {
        before(function () {
            shepherd._enabled = true;
        });

        describe('#.reset', function () {
            it('should throw if mode is not a number and not a string', function () {
                expect(function () { shepherd.reset({}); }).to.throw(TypeError);
                expect(function () { shepherd.reset(true); }).to.throw(TypeError);
            });
        });

        describe('#.permitJoin', function () {
            it('should throw if time is not a number', function () {
                expect(function () { shepherd.permitJoin({}); }).to.throw(TypeError);
                expect(function () { shepherd.permitJoin(true); }).to.throw(TypeError);
            });

            it('should throw if type is given but not a number and not a string', function () {
                expect(function () { shepherd.permitJoin({}); }).to.throw(TypeError);
                expect(function () { shepherd.permitJoin(true); }).to.throw(TypeError);
            });
        });

        describe('#.mount', function () {
            it('should throw if zApp is not an object', function () {
                expect(function () { shepherd.mount(true); }).to.throw(TypeError);
                expect(function () { shepherd.mount('ceed'); }).to.throw(TypeError);
            });
        });

        describe('#.list', function () {
            it('should throw if ieeeAddrs is not an array of strings', function () {
                expect(function () { shepherd.list({}); }).to.throw(TypeError);
                expect(function () { shepherd.list(true); }).to.throw(TypeError);
                expect(function () { shepherd.list([ 'ceed', {} ]); }).to.throw(TypeError);

                expect(function () { shepherd.list('ceed'); }).not.to.throw(Error);
                expect(function () { shepherd.list([ 'ceed', 'xxx' ]); }).not.to.throw(Error);
            });
        });

        describe('#.find', function () {
            it('should throw if addr is not a number and not a string', function () {
                expect(function () { shepherd.find({}, 1); }).to.throw(TypeError);
                expect(function () { shepherd.find(true, 1); }).to.throw(TypeError);
            });

            it('should throw if epId is not a number', function () {
                expect(function () { shepherd.find(1, {}); }).to.throw(TypeError);
                expect(function () { shepherd.find(1, true); }).to.throw(TypeError);
            });
        });

        describe('#.lqi', function () {
            it('should throw if ieeeAddr is not a string', function () {
                expect(function () { shepherd.lqi({}); }).to.throw(TypeError);
                expect(function () { shepherd.lqi(true); }).to.throw(TypeError);
                expect(function () { shepherd.lqi('ceed'); }).not.to.throw(TypeError);
            });
        });

        describe('#.remove', function () {
            it('should throw if ieeeAddr is not a string', function () {
                expect(function () { shepherd.remove({}); }).to.throw(TypeError);
                expect(function () { shepherd.remove(true); }).to.throw(TypeError);
                expect(function () { shepherd.remove('ceed'); }).not.to.throw(TypeError);
            });
        });
    });

    describe('Join Check', function () {
        var shepherd;
        before(function () {
            shepherd = new Shepherd('/dev/ttyUSB0', { dbPath: __dirname + '/database/dev4.db' });

            shepherd.controller.request = function (subsys, cmdId, valObj, callback) {
                var deferred = Q.defer();

                process.nextTick(function () {
                    deferred.resolve({ status: 0 });
                });

                return deferred.promise.nodeify(callback);
            };
        });

        describe('#.endDeviceAnnceHdlr', function () {
            it('unbind loEp1 and rmEp1', sinon.test(function (done) {
                var simpleDescReqStub = sinon.stub(shepherd.controller, 'simpleDescReq').callsFake(function (nwkAddr, ieeeAddr, callback) {
                    var deferred = Q.defer();

                    setImmediate(function () {
                        deferred.resolve({
                            type: 1,
                            nwkaddr: nwkAddr,
                            ieeeaddr: ieeeAddr,
                            manufId: 10,
                            epList: [],
                            endpoints: []
                        });
                    });

                    return deferred.promise.nodeify(callback);
                }),
                dev_1,
                dev_2;

                shepherd.on('ind:incoming', function (dev) {
                    if (dev.ieeeAddr === '0x123456789abcdef')
                        dev_1 = true;
                    else if (dev.ieeeAddr === '0x00124b000159168')
                        dev_2 = true;

                    if (dev_1 && dev_2)
                        done();
                });

                shepherd.controller.emit('ZDO:endDeviceAnnceInd', {
                    nwkaddr: 100,
                    ieeeaddr: '0x123456789abcdef'
                });
                shepherd.controller.emit('ZDO:endDeviceAnnceInd', {
                    nwkaddr: 200,
                    ieeeaddr: '0x00124b000159168'
                });
            }));
        });
    })

    describe('Functional Check', function () {
        var shepherd;
        before(function () {
            shepherd = new Shepherd('/dev/ttyUSB0', { dbPath: __dirname + '/database/dev1.db' });

            shepherd.controller.request = function (subsys, cmdId, valObj, callback) {
                var deferred = Q.defer();

                process.nextTick(function () {
                    deferred.resolve({ status: 0 });
                });

                return deferred.promise.nodeify(callback);
            };
        });
        


        describe('#.permitJoin', function () {
            it('should not throw if shepherd is not enabled when permitJoin invoked - shepherd is disabled.', sinon.test(function (done) {
                shepherd.permitJoin(3).fail(function (err) {
                    if (err.message === 'Shepherd is not enabled.')
                        done();
                }).done();
            }));

            it('should trigger permitJoin counter and event when permitJoin invoked - shepherd is enabled.', sinon.test(function (done) {
                shepherd._enabled = true;
                shepherd.once('permitJoining', function (joinTime) {
                    shepherd._enabled = false;
                    if (joinTime === 3)
                        done();
                });
                shepherd.permitJoin(3);
            }));
        });

        describe('#.start', function () {
            it('should start ok, _enabled true, _ready and ready should be fired', sinon.test(function (done) {
                var _readyCbCalled = false,
                    readyCbCalled = false,
                    startCbCalled = false,
                    startStub = this.stub(shepherd, 'start').callsFake(function (callback) {
                        var deferred = Q.defer();

                        shepherd._enabled = true;
                        shepherd.controller._coord = coordinator;
                        deferred.resolve();

                        setTimeout(function(){
                            shepherd.emit('_ready', true);
                        }, 20)

                        return deferred.promise.nodeify(callback);
                    });

                function d(){
                    if(shepherd._enabled) done()
                    else done("shepherd._enabled should be true")
                }

                shepherd.once('_ready', function () {
                    _readyCbCalled = true;
                    if (_readyCbCalled && readyCbCalled && startCbCalled)
                        setTimeout(function () {
                            d();
                        }, 200);
                });

                shepherd.once('ready', function () {
                    readyCbCalled = true;
                    if (_readyCbCalled && readyCbCalled && startCbCalled)
                        setTimeout(function () {
                            d();
                        }, 200);
                });

                shepherd.start(function (err) {
                    if(err){
                        done(err)
                        return
                    }
                    startCbCalled = true;
                    if (_readyCbCalled && readyCbCalled && startCbCalled)
                        setTimeout(function () {
                            d();
                        }, 200);
                });
            }));
        });

        describe('#.info', function () {
            it('should get correct info about the shepherd', sinon.test(function () {
                var getNwkInfoStub = this.stub(shepherd.controller, 'getNetInfo').returns({
                        state: 'Coordinator',
                        channel: 11,
                        panId: '0x7c71',
                        extPanId: '0xdddddddddddddddd',
                        ieeeAddr: '0x00124b0001709887',
                        nwkAddr: 0,
                        joinTimeLeft: 49
                    }),
                    shpInfo = shepherd.info();

                expect(shpInfo.enabled).to.be.true;
                expect(shpInfo.net).to.be.deep.equal({ state: 'Coordinator', channel: 11, panId: '0x7c71', extPanId: '0xdddddddddddddddd', ieeeAddr: '0x00124b0001709887', nwkAddr: 0 });
                expect(shpInfo.joinTimeLeft).to.be.equal(49);
                getNwkInfoStub.restore();
            }));
        });

        describe('#.mount', function () {
            it('should mount zApp', sinon.test(function (done) {
                var coordStub = sinon.stub(shepherd.controller.querie, 'coordInfo').callsFake(function (callback) {
                        return Q({}).nodeify(callback);
                    }),
                    syncStub = sinon.stub(shepherd._devbox, 'sync').callsFake(function (id, callback) {
                        return Q({}).nodeify(callback);
                    });

                shepherd.mount(zApp, function (err, epId) {
                    if (!err) {
                        coordStub.restore();
                        syncStub.restore();
                        done();
                    }
                });
            }));
        });

        describe('#.list', function () {
            this.timeout(5000);

            it('should list one devices', sinon.test(function (done) {
                shepherd._registerDev(dev1).then(function () {
                    var devList = shepherd.list();
                    expect(devList.length).to.be.equal(1);
                    expect(devList[0].type).to.be.equal(1);
                    expect(devList[0].ieeeAddr).to.be.equal('0x00137a00000161f2');
                    expect(devList[0].nwkAddr).to.be.equal(100);
                    expect(devList[0].manufId).to.be.equal(10);
                    expect(devList[0].epList).to.be.deep.equal([ 1 ]);
                    expect(devList[0].status).to.be.equal('offline');
                    done();
                }).fail(function (err) {
                    done(err)
                }).done();
            }));
        });

        describe('#.find', function () {
            it('should find nothing', sinon.test(function () {
                expect(shepherd.find('nothing', 1)).to.be.undefined;
            }));
        });

        describe('#.lqi', function () {
            it('should get lqi of the device', sinon.test(function (done) {
                var requestStub = sinon.stub(shepherd.controller, 'request').callsFake(function (subsys, cmdId, valObj, callback) {
                    var deferred = Q.defer();

                    process.nextTick(function () {
                        deferred.resolve({
                            srcaddr: 100,
                            status: 0,
                            neighbortableentries: 1,
                            startindex: 0,
                            neighborlqilistcount: 1,
                            neighborlqilist: [
                                {
                                    extPandId: '0xdddddddddddddddd',
                                    extAddr: '0x0123456789abcdef',
                                    nwkAddr: 200,
                                    deviceType: 1,
                                    rxOnWhenIdle: 0,
                                    relationship: 0,
                                    permitJoin: 0,
                                    depth: 1,
                                    lqi: 123
                                }
                            ]
                        });
                    });

                    return deferred.promise.nodeify(callback);
                });

                shepherd.lqi('0x00137a00000161f2', function (err, data) {
                    if (!err) {
                        expect(data[0].ieeeAddr).to.be.equal('0x0123456789abcdef');
                        expect(data[0].lqi).to.be.equal(123);
                        requestStub.restore();
                        done();
                    }
                });
            }));
        });

        describe('#.remove', function () {
            it('should remove the device', sinon.test(function (done) {
                var requestStub = sinon.stub(shepherd.controller, 'request').callsFake(function (subsys, cmdId, valObj, callback) {
                    var deferred = Q.defer();

                    process.nextTick(function () {
                        deferred.resolve({ srcaddr: 100, status: 0 });
                    });

                    return deferred.promise.nodeify(callback);
                });

                shepherd.remove('0x00137a00000161f2', function (err) {
                    if (!err) {
                        requestStub.restore();
                        done();
                    }
                });
            }));
        });

        describe('#.reset', function () {
            this.timeout(2000);
            it('should reset - soft', sinon.test(function (done) {                
                var stopStub = this.stub(shepherd, 'stop').callsFake(function (callback) {
                    var deferred = Q.defer();
                    deferred.resolve();
                    return deferred.promise.nodeify(callback);
                }),
                startStub = this.stub(shepherd, 'start').callsFake(function (callback) {
                    var deferred = Q.defer();
                    deferred.resolve();
                    stopStub.restore();
                    startStub.restore();
                    done()
                    return deferred.promise.nodeify(callback);
                });


                shepherd.reset('soft').done();

                //Fake module response
                setTimeout(function(){                
                    shepherd.controller.emit('SYS:resetInd')
                }, 20)
            }));

            it('should reset - hard', sinon.test(function (done) {
                var stopStub = this.stub(shepherd, 'stop').callsFake(function (callback) {
                        var deferred = Q.defer();
                        deferred.resolve();
                        return deferred.promise.nodeify(callback);
                    }),
                    startStub = this.stub(shepherd, 'start').callsFake(function (callback) {
                        var deferred = Q.defer();
                        deferred.resolve();
                        stopStub.restore();
                        startStub.restore();
                        done()
                        return deferred.promise.nodeify(callback);
                    });


                shepherd.reset('hard').done();

                //Fake module response
                setTimeout(function(){                
                    shepherd.controller.emit('SYS:resetInd')
                }, 20)
            }));
        });

        describe('#.stop', function () {
            it('should stop ok, _enabled should be false', function (done) {
                var stopCalled = false,
                    closeStub = sinon.stub(shepherd.controller, 'close').callsFake(function (callback) {
                        var deferred = Q.defer();

                        deferred.resolve();

                        return deferred.promise.nodeify(callback);
                    });

                shepherd.stop(function (err) {
                    stopCalled = true;
                    if (!err) {
                        closeStub.restore();
                        if(!shepherd._enabled){
                            done();
                        }else{
                            done("shepherd._enabled should be false")
                        }
                    }
                });
            });
        });
    });
});
