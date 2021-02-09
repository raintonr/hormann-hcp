const SerialPort = require('serialport');
const HCPParser = require('./parser-hcp');

// Address to respond to. Emulate an 'Intelligent control panel' (16-45)
const icAddress = 40;

console.log('Setting up port...');
const port = new SerialPort('/dev/ttyUSB0', {
    autoOpen: false,
    baudRate: 19200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    highWaterMark: 1
});

var toSend;
var masterStatus;
var lastData = Date.now();

console.log('Initiating parser...');
const hcpParser = new HCPParser({ receiveAddress: icAddress });
const parser = port.pipe(hcpParser);
parser.on('data', (buffer) => {
    const delay = dataDelay();
//    console.log(`\n+${delay}\tData\t ${buffer.toString('hex')}`);
    if (buffer[0] === 0) {
//        process.stdout.write(`\t\t\t\t\t\t\t+${delay}\tBroadcast\t ${buffer.toString('hex')}\r`);
        const currentStatus = buffer[2];

        // Status mask for LineaMatic P:
        // +------- (0x80) Unknown
        //  +------ (0x40) Motor running: 1 == running. 0 == stopped.
        //   +----- (0x20) Motor direction: 1 == closing. 0 == opening.
        //    +---- (0x10) Unknown
        //     +--- (0x08) Unknown (fully closed?)
        //      +-- (0x04) Reed switch: 1 == no magnet. 0 == magnet present (fully open).
        //       +- (0x02) Unknown
        //        + (0x01) Unknown

        if (masterStatus !== currentStatus) {
            masterStatus = currentStatus;
            console.log(`\n+${delay}\tNew status\t ${buffer.toString('hex')} -> ${masterStatus.toString(2)}`);
        }
    } else if (buffer[0] === icAddress) {
        // Something for our address
        if (buffer[2] === 0x01) {
            // Slave query
            console.log(`\n+${delay}\tSlave query\t ${buffer.toString('hex')}`);

            //Reply pretending to be a UAP1
            // 3: Device type (UAP1 is allegedly 20)
            // 4: Device address
            makeSend(buffer[3], [20, icAddress]);
        } else {
            console.error(`\n+${delay}\tUnknown message for us\t ${buffer.toString('hex')}`);
        }
    } else {
        console.log(`+${delay}\tUnknown ${buffer.length}\t ${buffer.toString('hex')}`);
    }

    // If we have something to send out, do it now
    if (Buffer.isBuffer(toSend) && toSend.length > 0) {
        // Wait at little before replying. TODO: just experimentation!
        setTimeout(() => {
            const delay = dataDelay();
            console.log(`+${delay}\tSending ${toSend.length}\t ${toSend.toString('hex')}`);
            if (!port.write(toSend, 'binary', (err) => {
                if (err) {
                    console.log('Error writing: ', err.message)
                }
            })) {
                console.log('We should wait for drain!');
            };
            toSend = undefined;
        }, 1);
    }
});

function dataDelay() {
    // Work out delay since last message
    const dataTime = Date.now();
    const dataDelay = dataTime - lastData;
    lastData = dataTime;
    return dataDelay;
}

// Specification calls for a rotating counter for each transmit
var counter = 0;
function makeSend(target, bytes) {
    // Pad start with x empty bytes. TODO: just experimentation!
    const emptyStart = 0;

    toSend = new Buffer.alloc(bytes.length + 3 + emptyStart);

    toSend[emptyStart] = target;
    toSend[emptyStart + 1] = bytes.length;

    // Increment & add in counter (shifted)
    counter = counter == 0x0f ? 0 : counter + 1;
    toSend[emptyStart + 1] = toSend[emptyStart + 1] | (counter << 4);

    // TODO: cater for more than 2 bytes
    toSend[emptyStart + 2] = bytes[0];
    toSend[emptyStart + 3] = bytes[1];

    toSend[toSend.length - 1] = hcpParser.computeCRC(toSend.slice(emptyStart, toSend.length - 1));
}

console.log('Opening port...');
port.open((err) => {
    if (err) {
        console.log('Error opening port: ', err.message)
    }
});
