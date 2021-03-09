const SerialPort = require('serialport');

// Some options for testing
const readOnly = true;
const promiscuous = false;

// Timespan with no data before we consider a new packet starts (nanoseconds);
const packetInterval = BigInt(200000);

// Timespan which we will force a new packet, even if one appears to be in progress;
const packetForceInterval = BigInt(30000000);

// What's the maximum length message we think should be handled?
const maxMessageLength = 3;

// Address to respond to. Emulate an 'Intelligent control panel' (16-45)
const icAddress = 0x28;

// Address of gate motor 'master' - should be noted when bus scan received.
var masterAddress;

const portOptions = {
    baudRate: 19200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
}
console.log('Setting up port...');
const port = new SerialPort('/dev/ttyAMA0', {
    autoOpen: false,
    highWaterMark: 1, // Necessary for the parser to process messages byte at a time
    ...portOptions
});

// Globals for current packet. TODO: clean this up later
var packetTime = BigInt(0);
var currentPacketInProgress = false;

// CRC calc
const CRC = require('crc-full').CRC;
const crcCalculator = new CRC('CRC8', 8, 0x07, 0xf3, 0x00, false, false);

var masterStatus;
var lastChunk = BigInt(0);
var lastData = process.hrtime.bigint();

// Specification calls for a rotating counter
var counter = 0;

// Prepare for when we will use keyboard input to send
var ourStatus = 0x00;
var stdin = process.stdin;
stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding('utf8');
stdin.on('data', function (key) {
    // ctrl-c ( end of text )
    if (key === '\u0003') {
        process.exit();
    }
    // write the key to stdout all normal like
    if (key >= '1' && key < '9') {
        console.log(`Sending command ${key}`);
        ourStatus ^= 1 << (key - 1);
    } else {
        console.log('Reset command');
        ourStatus = 0;
    }
    console.log(`OurStatus: ${ourStatus.toString(2)}`);
});

function newPacket() {
    packetTime = process.hrtime.bigint();
    currentPacket = [];
    currentPacketEnd = 0;
    currentPacketInProgress = true;
}

port.on('data', (chunk) => {
    const delay = dataDelay();

    console.log(`\t\t\t\t\t+${delay}\tNew chunk (${chunk.length})\t${chunk.toString('hex')}`);
    if (chunk.length !== 1) {
        console.error('Chunk should always be 1!');
    } else {
        const byte = chunk[0];

        if (delay > packetInterval && !currentPacketInProgress) {
            // Transmission window passed, start a new packet
            console.error(`New packet after ${delay}`);
            newPacket();
        } else if (delay > packetForceInterval) {
            console.error(`Forcing new packet after ${delay}`);
            newPacket();
        }

        /*
         * Tricky situation...
         *
         * On some USB UART devices seems the 'break' that each packet starts with is interpreted
         * as an error (guessing?) and a zero value byte is thrown out here.
         *
         * On some other UART devices this doesn't seem to happen, but don't know how to detect that
         * and therefore how to detect 'break' on these.
         *
         * So we have to assume that a packet will sometimes have an extra zero value byte at the start
         */
        if (currentPacketInProgress) {
            const byteSeq = currentPacket.length;
            if (byteSeq === 0) {
                // Stash this as the first byte in our buffer.
                // console.log(`\t\tNew packet starting ${byte.toString('16')}`);
                currentPacket.push(byte);
            } else if (byteSeq === 1) {
                // Counter/message length
                // High nibble == counter. TODO: ignore for now
                // Low nibble == length
                var nibbleMessageLength = byte & 0x0f;

                // If the length looks dodgy and & the starting byte was zero let's assume
                // the starting byte we had was a result of BRK and replace it.
                if (currentPacket[0] === 0 && (
                    byte === 0 || nibbleMessageLength === 0 || nibbleMessageLength > maxMessageLength)) {
                    console.log(`\t\tLooks like a premature start to packet, replacing with ${byte.toString('16')}`);
                    currentPacket[0] = byte;
                } else {
                    // Looks good
                    // So last byte of this message will be...
                    currentPacketEnd = nibbleMessageLength + byteSeq + 1;
                    // console.log(`\t\tCurrent packet will end byte ${currentPacketEnd}`);
                    currentPacket.push(byte);
                }
            } else if (byteSeq < currentPacketEnd) {
                // console.log(`\t\tData: ${byte}`);
                currentPacket.push(byte);
            } else {
                // Last byte of message - this is CRC
                const crc = crcCalculator.compute(currentPacket);
                if (byte !== crc) {
                    console.error(`\t\tCRC: ${byte} != ${crc}`);
                } else if (promiscuous || currentPacket[0] === 0 || currentPacket[0] === icAddress) {
                    // Promiscuous mode, broadcast packet or for receive address
                    processPacket(currentPacket);
                }
                // We've finished either way
                currentPacketInProgress = false;
            }
        }
    }
});

function processPacket(buffer) {
    const delay = dataDelay(packetTime);
    //    console.log(`+${delay}\tData\t ${buffer.toString('hex')}`);

    var reply;
    if (buffer[0] === 0) {
        process.stdout.write(`\t\t\t\t\t\t\t+${delay}\tBroadcast\t ${buffer.toString('hex')}\r`);
        const currentStatus = buffer[2];

        // Status mask for LineaMatic P:
        // +------- (0x80) Unknown
        //  +------ (0x40) Motor running: 1 == running. 0 == stopped.
        //   +----- (0x20) Motor direction: 1 == closing. 0 == opening.
        //    +---- (0x10) Unknown
        //     +--- (0x08) Unknown
        //      +-- (0x04) Unknown
        //       +- (0x02) Fully closed 
        //        + (0x01) Fully open

        if (true || masterStatus !== currentStatus) {
            masterStatus = currentStatus;
            console.log(`\n+${delay}\tNew status\t ${buffer.toString('hex')} -> ${masterStatus.toString(2)}`);
        }
    } else if (buffer[0] === icAddress) {
        // Something for our address
        // Pull counter out of message for any reply
        counter = buffer[1] & 0xf0;
        counter = counter >> 4;

        if (buffer[2] === 0x01) {
            // Slave query
            console.log(`+${delay}\tSlave query\t ${buffer.toString('hex')}`);

            // Note master address
            masterAddress = buffer[3];

            // Reply pretending to be a UAP1
            // 3: Device type (UAP1 is allegedly 20)
            // 4: Device address

            reply = makeSend(masterAddress, [20 /* arbitrary type */, icAddress]);
        } else if (buffer[2] == 0x20) {
            // Slave status request
            //            console.log(`+${delay}\tSlave status request\t ${buffer.toString('hex')}`);

            // Command mask for LineaMatic P:
            // +------- (0x80) Unknown
            //  +------ (0x40) Unknown
            //   +----- (0x20) Unknown
            //    +---- (0x10) Moves to 'H' (whatever that means)
            //     +--- (0x08) Unknown
            //      +-- (0x04) Impulse toggle
            //       +- (0x02) Impulse close
            //        + (0x01) Impulse open

            // For some reason the second byte needs to be 0x10 (signals no error?)
            reply = makeSend(masterAddress, [0x29 /* slave status */, ourStatus, 0x10]);

            // Clear any commands after send
            ourStatus = 0;
        } else {
            console.error(`\n+${delay}\tUnknown message for us\t ${buffer.toString('hex')}`);
        }
    } else {
        //        console.log(`+${delay}\tUnknown ${buffer.length}\t ${buffer.toString('hex')}`);
    }

    if (Buffer.isBuffer(reply)) {
        breakWrite(reply);
    }
}

function breakWrite(toSend) {
    // Don't ever send anything if readOnly
    if (readOnly) return;

    const delay = dataDelay();
    //    console.log(`+${delay}\tBreak/send\t${toSend.length}\t${toSend.toString('hex')}`);
    port.update({
        baudRate: 9600,
        dataBits: 7,
        parity: 'none',
        stopBits: 1,
    }, (err) => {
        if (err) {
            console.error('Error updating port: ', err.message);
        } else {
            port.write([0], (err) => {
                if (err) {
                    console.error('Error writing: ', err.message);
                }
            });
            port.drain((err) => {
                if (err) {
                    console.error('Error draining: ', err.message);
                }
                // Put port settings back and send our message
                port.update(portOptions, (err) => {
                    if (err) {
                        console.error('Error updating port: ', err.message);
                    }
                    writeDrain(toSend);
                });
            });
        }
    });
}

function writeDrain(toSend) {
    const delay = dataDelay();
    //    console.log(`+${delay}\tSending\t${toSend.length}\t${toSend.toString('hex')}`);
    port.write(toSend, (err) => {
        if (err) {
            console.error('Error writing: ', err.message)
        }
    });
    port.drain((err) => {
        if (err) {
            console.error('Error draining: ', err.message);
        }
    });
}

function dataDelay(dataTime) {
    // Work out delay since last message
    if (typeof(dataTime) === 'undefined') {
        dataTime = process.hrtime.bigint();
    }
    const dataDelay = dataTime - lastData;
    lastData = dataTime;
    return dataDelay;
}

function makeSend(target, bytes) {
    // Pad start with x empty bytes. TODO: just experimentation!
    const emptyStart = 0;

    const toSend = new Buffer.alloc(bytes.length + 3 + emptyStart);

    toSend[emptyStart] = target;
    toSend[emptyStart + 1] = bytes.length;

    // Increment & add in counter (shifted)
    counter = counter == 0x0f ? 0 : counter + 1;
    toSend[emptyStart + 1] = toSend[emptyStart + 1] | (counter << 4);

    for (var lp = 0; lp < bytes.length; lp++) {
        toSend[emptyStart + 2 + lp] = bytes[lp];
    }
    toSend[toSend.length - 1] = crcCalculator.compute(toSend.slice(emptyStart, toSend.length - 1));

    return toSend;
}

console.log('Opening port...');
port.open((err) => {
    if (err) {
        console.log('Error opening port: ', err.message)
    }
});
