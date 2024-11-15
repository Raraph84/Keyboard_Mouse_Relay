const { SeqpacketSocket } = require("node-unix-socket");
const { decodeMouse, encodeMouse, decodeModifiers, decodeKeys, encodeKeys, getBluetoothInputHostPaths } = require("./utils");
const fs = require("fs");
const net = require("net");
const ioctl = require("ioctl");
const keymap = require("./keymap");

require("dotenv").config();

const mouseSpeed = 1.1;

(async () => {

    const device = fs.readdirSync("/sys/bus/hid/devices")[0];
    const hidraw = fs.readdirSync("/sys/bus/hid/devices/" + device + "/hidraw")[0];
    const events = fs.readdirSync("/sys/bus/hid/devices/" + device + "/input");

    for (const event of events) {
        const inputEvents = fs.readdirSync("/sys/bus/hid/devices/" + device + "/input/" + event).filter((inputEvent) => inputEvent.startsWith("event"));
        for (const inputEvent of inputEvents)
            ioctl(fs.openSync("/dev/input/" + inputEvent, "r"), 0x40044590, 1);
    }

    const keyboardSockets = [];
    const mouseSockets = [];
    const server = net.createServer((socket) => {

        let data = "";
        socket.on("data", (chunk) => {

            data += chunk;
            if (!data.includes("\n")) return;

            const message = data.split("\n").shift();
            let json;
            try {
                json = JSON.parse(message);
            } catch (error) {
                socket.end();
                return;
            }

            if (!json.token || json.token !== process.env.TOKEN) {
                socket.end();
                return;
            }

            if (!json.type || !["mouse", "keyboard"].includes(json.type)) {
                socket.end();
                return;
            }

            const sockets = json.type === "mouse" ? mouseSockets : keyboardSockets;

            sockets.push(socket);
            console.log("Client connected to the server", socket.remoteAddress, json.type);
            socket.on("close", () => {
                sockets.splice(sockets.indexOf(socket), 1);
                console.log("Client disconnected from the server", socket.remoteAddress, json.type);
            });
        });
        socket.on("error", () => { });
    });
    server.listen(process.env.PORT, () => console.log("Server started."));

    let interruptSocketFinal;
    (async () => {

        let inputHostPaths = await getBluetoothInputHostPaths();
        if (!inputHostPaths) {
            console.log("Bluetooth input host not found. Waiting for it to appear...");
            while (!inputHostPaths) {
                inputHostPaths = await getBluetoothInputHostPaths();
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }

        const controlSocket = new SeqpacketSocket();
        controlSocket.connect(inputHostPaths.control, () => console.log("Connected to control socket", inputHostPaths.control));

        const interruptSocket = new SeqpacketSocket();
        interruptSocket.connect(inputHostPaths.interrupt, () => console.log("Connected to interrupt socket", inputHostPaths.interrupt));

        interruptSocketFinal = interruptSocket;
    })();

    const send = (bytes) => interruptSocketFinal && interruptSocketFinal.write(Buffer.from([161, ...bytes]));

    const remotePressedKeys = [];
    let oldKeys = encodeKeys(remotePressedKeys, keymap).keys;
    let oldMedia = encodeKeys(remotePressedKeys, keymap).media;
    const updateKeys = () => {

        const { keys, media } = encodeKeys(remotePressedKeys, keymap);

        if (JSON.stringify(keys) !== JSON.stringify(oldKeys)) send(keys);
        if (JSON.stringify(media) !== JSON.stringify(oldMedia)) send(media);

        oldKeys = keys;
        oldMedia = media;
    };

    const pressKey = (key) => {
        if (remotePressedKeys.includes(key)) return;
        remotePressedKeys.push(key);
        updateKeys();
    };

    const releaseKey = (key) => {
        if (!remotePressedKeys.includes(key)) return;
        remotePressedKeys.splice(remotePressedKeys.indexOf(key), 1);
        updateKeys();
    };

    const clickKey = (key) => {
        pressKey(key);
        releaseKey(key);
    };

    let oldPressedKeys = [];
    let oldPressedMedia = [];
    let oldButton = 0;
    fs.createReadStream("/dev/" + hidraw, { flags: "r", highWaterMark: 64 }).on("data", (buffer) => {

        if (buffer[0] === 5) { // Mouse

            let { button, x, y, yScroll, xScroll } = decodeMouse(buffer);
            x = Math.round(x * mouseSpeed);
            y = Math.round(y * mouseSpeed);

            send(encodeMouse(button, x, y, yScroll, xScroll));

            for (const socket of mouseSockets) {
                try {
                    if (x !== 0 || y !== 0) socket.write("0 " + x + " " + y + "\n");
                    if (button !== oldButton || yScroll !== 0 || xScroll !== 0) socket.write("1 " + button + " " + yScroll + " " + xScroll + "\n");
                } catch (error) {
                }
            }

            oldButton = button;

        } else if (buffer[0] === 1) { // Keyboard

            const keys = decodeKeys(buffer, keymap);
            if (!keys) return;
            const pressedKeys = keys.concat(decodeModifiers(buffer[1], keymap.modifiers));
            oldPressedKeys = pressedKeys;

            if (pressedKeys.includes("HOME")) {
                clickKey("SPACE");
                setTimeout(() => clickKey("SPACE"), 500);
                setTimeout(() => {
                    for (const c of "***REMOVED***")
                        clickKey(c);
                }, 1000);
                return;
            }

            for (const socket of keyboardSockets) {
                try {
                    socket.write(pressedKeys.concat(oldPressedMedia).join(" ") + "\n");
                } catch (error) {
                }
            }

        } else if (buffer[0] === 2) { // Media

            const pressedMedia = decodeModifiers(buffer[1], keymap.media1).concat(decodeModifiers(buffer[2], keymap.media2)).concat(decodeModifiers(buffer[3], keymap.media3));
            oldPressedMedia = pressedMedia;

            if (pressedMedia.includes("POWER")) {
                clickKey("POWER");
                return;
            }

            for (const socket of keyboardSockets) {
                try {
                    socket.write(pressedMedia.concat(oldPressedKeys).join(" ") + "\n");
                } catch (error) {
                }
            }
        }
    });
})();
