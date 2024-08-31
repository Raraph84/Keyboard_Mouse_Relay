const { SeqpacketSocket } = require("node-unix-socket");
const fs = require("fs");
const net = require("net");
const ioctl = require("ioctl");
const dbus = require("dbus-native");
const keymap = require("./keymap");

require("dotenv").config();

const mouseSpeed = 1.1;

const getBluetoothInputHostPaths = async () => {

    const bus = dbus.systemBus();

    const objManager = await new Promise((resolve) => bus.getService("org.bluez").getInterface("/", "org.freedesktop.DBus.ObjectManager", (error, objManager) => {
        if (error) throw error;
        resolve(objManager);
    }));

    const objs = await new Promise((resolve) => objManager.GetManagedObjects((error, objs) => {
        if (error) throw error;
        resolve(objs);
    }));

    const inputObj = objs.find((obj) => JSON.stringify(obj[1]).includes("org.bluez.InputHost1"));
    if (!inputObj) return null;

    const inputHost = await new Promise((resolve) => bus.getService("org.bluez").getInterface(inputObj[0], "org.bluez.InputHost1", (error, inputHost) => {
        if (error) throw error;
        resolve(inputHost);
    }));

    const socketPathCtrl = await new Promise((resolve) => inputHost.$readProp("SocketPathCtrl", (error, path) => {
        if (error) throw error;
        resolve(path);
    }));

    const socketPathIntr = await new Promise((resolve) => inputHost.$readProp("SocketPathIntr", (error, path) => {
        if (error) throw error;
        resolve(path);
    }));

    return { control: socketPathCtrl, interrupt: socketPathIntr };
};

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

    const send = (bytes) => {
        if (!interruptSocketFinal) return;
        interruptSocketFinal.write(Buffer.from([161, ...bytes]));
    };

    const decodeMouse = (bytes) => {
        const button = bytes[1];
        const hex = bytes.slice(2, 5).toString("hex");
        const hex1 = parseInt(hex[3] + hex[0] + hex[1], 16);
        const hex2 = parseInt(hex[4] + hex[5] + hex[2], 16);
        const x = hex1 < 2048 ? hex1 : hex1 - 4096;
        const y = hex2 < 2048 ? hex2 : hex2 - 4096;
        const yScroll = bytes[5] < 128 ? bytes[5] : bytes[5] - 256;
        const xScroll = bytes[6] < 128 ? bytes[6] : bytes[6] - 256;
        return { button, x, y, yScroll, xScroll };
    };

    const encodeMouse = (button, x, y, yScroll, xScroll) => {
        const hex1 = (x < 0 ? x + 4096 : x).toString(16).padStart(3, "0");
        const hex2 = (y < 0 ? y + 4096 : y).toString(16).padStart(3, "0");
        const hex = hex1 + hex2;
        const yScrollByte = yScroll < 0 ? yScroll + 256 : yScroll;
        const xScrollByte = xScroll < 0 ? xScroll + 256 : xScroll;
        return [5, button, parseInt(hex[1] + hex[2], 16), parseInt(hex[5] + hex[0], 16), parseInt(hex[3] + hex[4], 16), yScrollByte, xScrollByte];
    };

    const decodeModifiers = (byte, map) => {
        const modifiers = [];
        for (let value in map) {
            value = parseInt(value);
            if ((byte & value) !== 0) modifiers.push(map[value]);
        }
        return modifiers;
    };

    const decodeKeys = (bytes) => {
        const pressedKeys = [];
        for (let i = 2; i < bytes.length; i++) {
            const keyCode = bytes[i];
            if (keyCode === 0x01) return null;
            if (keyCode !== 0) {
                const key = keymap.keys[keyCode];
                if (key) pressedKeys.push(key);
            }
        }
        return pressedKeys;
    };

    const encodeKeys = (pressedKeys) => {

        const keys = [1, 0, 0];
        const media = [2, 0, 0, 0];
        for (const key of pressedKeys) {
            for (const k in keymap.keys)
                if (keymap.keys[k] === key)
                    keys.push(parseInt(k));
            for (const k in keymap.modifiers)
                if (keymap.modifiers[k] === key)
                    keys[1] |= parseInt(k);
            for (const k in keymap.media1)
                if (keymap.media1[k] === key)
                    media[1] |= parseInt(k);
            for (const k in keymap.media2)
                if (keymap.media2[k] === key)
                    media[2] |= parseInt(k);
            for (const k in keymap.media3)
                if (keymap.media3[k] === key)
                    media[3] |= parseInt(k);
        }
        while (keys.length < 9) keys.push(0);

        return { keys, media };
    };

    const remotePressedKeys = [];
    let oldKeys = encodeKeys(remotePressedKeys).keys;
    let oldMedia = encodeKeys(remotePressedKeys).media;
    const updateKeys = () => {

        const { keys, media } = encodeKeys(remotePressedKeys);

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

            const keys = decodeKeys(buffer);
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
