const SerialPort = require('serialport');

// Debug messages
const baseDebug = 'hormann-hcp';
const logChunks = require('debug')(baseDebug + ':chunks');
const logPacketState = require('debug')(baseDebug + ':packetState');
const logPacketStart = require('debug')(baseDebug + ':packetStart');
const logPacketProcess = require('debug')(baseDebug + ':packetProcess');
const logPacketAction = require('debug')(baseDebug + ':packetAction');
const logTX = require('debug')(baseDebug + ':TX');

// Some options for testing
const readOnly = false;
const promiscuous = false;

// Timespan which we will force a new packet, even if one appears to be in progress.
const packetForceInterval = BigInt(6000000);

// What's the maximum length message we think should be handled?
const maxMessageLength = 3;
const maxPacketSize = maxMessageLength + 3;

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

// Globals for packets. TODO: clean this up later
var packetTime = BigInt(0);
var currentPacketInProgress = false;
var currentPacketResetCounter = false;
var nextCounter = 0;

// CRC calc
const CRC = require('crc-full').CRC;
const crcCalculator = new CRC('CRC8', 8, 0x07, 0xf3, 0x00, false, false);

var masterStatus;
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

console.log('Setting up port...');
const port = new SerialPort('/dev/ttyUSB0', {
    autoOpen: false,
    highWaterMark: 1, // Necessary for the parser to process messages byte at a time
    ...portOptions
});

port.on('error', (err) => {
    console.error(`error event: ${error}`);
});

function newPacket() {
    packetTime = process.hrtime.bigint();
    currentPacket = [];
    currentPacketEnd = 0;
    currentPacketInProgress = true;
    currentPacketResetCounter = false;
}

port.on('data', (chunk) => {
    const delay = dataDelay();
    logChunks(`Chunk after ${delay} : (${chunk.length}) ${chunk.toString('hex')}`);
    if (chunk.length !== 1) {
        console.error('Chunk length should always be 1!');
    } else {
        /*
         * Start a new packet if none in progress. Through testing found that trying to
         * use timing here didn't work well across platforms.
         * Naturally, this means a new packet could be started here part way through
         * transmission. Turns out that isn't an issue as we can detect bad packets
         * with CRC and other checks and very regularly there is a larger, more reliable
         * delay (the packetForceInterval) that causes everything to reset.
         */

        if (!currentPacketInProgress) {
            // Transmission window passed, start a new packet
            logPacketStart(`New packet after ${delay}`);
            newPacket();
        } else if (delay > packetForceInterval) {
            // packetForceInterval is to reset packets that appear to just run on and on after
            // what appear to be genuine CRC or other errors.
            logPacketStart(`Forcing new packet after ${delay}`);
            newPacket();
            /*
             * As this probably happened after genuine CRC error means we probably missed a
             * packet and our counter will be out of sync, so set flag that will copy from next
             * good packet.
             */
            currentPacketResetCounter = true;
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
         * So we have to assume that a packet will sometimes have an extra zero value byte at the start.
         * 
         * Below is rather inelegant, but basically it brute-force checks every packet against the known
         * logic from byte zero and from byte one then uses the one that checks out (if either do).
         */

        currentPacket.push(chunk[0]);
        if (isGoodPacket(currentPacket)) {
            logPacketProcess(`Whole packet checks out`);
            processPacket(new Buffer.from(currentPacket));
        } else if (isGoodPacket(currentPacket.slice(1))) {
            logPacketProcess(`Truncated packet checks out`);
            processPacket(new Buffer.from(currentPacket.slice(1)));
        }
    }
});

// Determine if the buffer passed represents a good packet
function isGoodPacket(buffer) {
    // Don't bother if buffer is too small
    if (buffer.length < 3) return false;

    // Assume good
    var isGood = true;

    var targetAddress = buffer[0];
    // TODO: check targetAddress is valid?

    // High nibble == counter.
    const nibbleCounter = extractPacketCounter(buffer);
    if (!currentPacketResetCounter && nibbleCounter !== nextCounter) {
        logPacketState(`Bad message counter: ${nibbleCounter} != ${nextCounter}`);
        isGood = false;
    }

    // Low nibble == length
    const nibbleMessageLength = buffer[1] & 0x0f;
    if (nibbleMessageLength === 0 || nibbleMessageLength > maxMessageLength) {
        logPacketState(`Bad data length: ${nibbleMessageLength}`);
        isGood = false;
    }
    const expectedPacketLength = nibbleMessageLength + 3

    if (buffer.length !== expectedPacketLength) {
        logPacketState(`Packet length mismatch: ${buffer.length} != ${expectedPacketLength}`);
        isGood = false;
    } else {
        // Only work out the CRC if the length looks OK
        const crc = crcCalculator.compute(currentPacket.slice(0, expectedPacketLength - 1));
        const crcByte = buffer[expectedPacketLength - 1];
        if (crcByte !== crc) {
            logPacketState(`Bad CRC: ${crcByte} != ${crc}`);
        }
    }

    return isGood;
}

function extractPacketCounter(buffer) {
    return (buffer[1] & 0xf0) >> 4;
}

function processPacket(buffer) {
    logPacketProcess(`Packet RX: ${buffer.toString('hex')}`);

    currentPacketInProgress = false;

    if (currentPacketResetCounter) {
        // Reset our counter to match that of the RX packet
        nextCounter = extractPacketCounter(buffer);
        logPacketState(`Reset counter to ${nextCounter}`);
    }
    nextCounter = nextCounter >= 15 ? 0 : nextCounter + 1;

    // Ignore if not for us
    if (!promiscuous && buffer[0] !== 0 && buffer[0] !== icAddress) {
        return;
    }

    // OK, of interest, process it
    var reply;
    if (buffer[0] === 0) {
        logPacketAction(`Broadcast ${buffer.toString('hex')}`);
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

        if (masterStatus !== currentStatus) {
            masterStatus = currentStatus;
            logPacketAction(`New status ${buffer.toString('hex')} -> ${masterStatus.toString(2)}`);
        }
    } else if (buffer[0] === icAddress) {
        // Something for our address
        // Pull counter out of message for any reply
        counter = buffer[1] & 0xf0;
        counter = counter >> 4;

        if (buffer[2] === 0x01) {
            // Slave query
            logPacketAction(`Slave query ${buffer.toString('hex')}`);

            // Note master address
            masterAddress = buffer[3];

            // Reply pretending to be a UAP1
            // 3: Device type (UAP1 is allegedly 20)
            // 4: Device address

            reply = makeSend(masterAddress, [20 /* arbitrary type */, icAddress]);
        } else if (buffer[2] == 0x20) {
            // Slave status request
            logPacketAction(`Slave status request ${buffer.toString('hex')}`);

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
            logPacketAction(`Unknown message for us ${buffer.toString('hex')}`);
        }
    }

    if (Buffer.isBuffer(reply)) {
        breakWrite(reply);
    }
}

function breakWrite(toSend) {
    // Don't ever send anything if readOnly
    if (readOnly) return;

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
    logTX(`Sending ${toSend.length} ${toSend.toString('hex')}`);
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
    if (typeof (dataTime) === 'undefined') {
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
