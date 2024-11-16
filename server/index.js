const { exec } = require("child_process");
const { SeqpacketSocket } = require("node-unix-socket");
const { getBluetoothInputHostPaths, decodeMouse, decodeModifiers, decodeKeys, encodeKeys, toByte } = require("./utils");
const fs = require("fs");
const net = require("net");
const ioctl = require("ioctl");
const keymap = require("./keymap");

if (process.getuid() !== 0) {
    console.error("Please run this script as root.");
    process.exit(1);
}

require("dotenv").config();

const keyboardSockets = [];
const mouseSockets = [];
const server = net.createServer((socket) => {

    let type = null;

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

        if (type) {
            socket.end();
            return;
        }

        type = json.type;

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

    const mac = inputHostPaths.control.split("_")[1];

    console.log("Bluetooth input host found", mac);

    /*const controlSocket = new SeqpacketSocket();
    console.log("Connecting to the control socket...");
    await new Promise((resolve) => controlSocket.connect(inputHostPaths.control, resolve));*/

    const interruptSocket = new SeqpacketSocket();
    console.log("Connecting to the interrupt socket...");
    await new Promise((resolve) => interruptSocket.connect(inputHostPaths.interrupt, resolve));

    interruptSocketFinal = interruptSocket;
    console.log("Bluetooth device ready.");

    setInterval(async () => {

        const cons = await new Promise((resolve, reject) => exec("hcitool con", (error, stdout) => error ? reject(error) : resolve(stdout)));
        const con = cons.split("\n").find((con) => con.includes(mac));
        if (!con || con.includes("MASTER")) return;

        try {
            await new Promise((resolve, reject) => exec(`hcitool sr ${mac} MASTER`, (error, stdout) => error ? reject(error) : resolve(stdout)));
        } catch (error) {
            console.error("Failed to set the bluetooth device to master.", error);
            return;
        }

        console.log("Bluetooth device set to master.");

    }, 1000);

})();

const send = (bytes) => interruptSocketFinal && interruptSocketFinal.write(Buffer.from([161, ...bytes]));

let remotePressedKeys = [];
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

let bluetoothKeyboardEnabled = false;
let bluetoothMouseEnabled = true;

const broadcastKeys = (keys) => {
    for (const socket of keyboardSockets) {
        try {
            socket.write(keys.join(" ") + "\n");
        } catch (error) {
        }
    }
};

const keyboardHandler = (keys) => {

    if (keys.length === 2 && keys.includes("LEFT_ALT") && keys.includes("HOME")) {
        clickKey("SPACE");
        setTimeout(() => clickKey("SPACE"), 500);
        setTimeout(() => {
            pressKey("LEFT_SHIFT");
            for (const c of "***REMOVED***")
                clickKey(c);
            releaseKey("LEFT_SHIFT");
        }, 1000);
        return;
    }

    if (keys.length === 1 && keys.includes("POWER")) {
        clickKey("POWER");
        return;
    }

    if (keys.length === 2 && keys.includes("RIGHT_ALT") && keys.includes("PAUSE")) {
        bluetoothKeyboardEnabled = !bluetoothKeyboardEnabled;
        console.log("Bluetooth keyboard", bluetoothKeyboardEnabled ? "enabled" : "disabled");
        remotePressedKeys = [];
        updateKeys();
        broadcastKeys([]);
        return;
    }

    if (keys.length === 2 && keys.includes("RIGHT_ALT") && keys.includes("PRINT_SCREEN")) {
        bluetoothMouseEnabled = !bluetoothMouseEnabled;
        console.log("Bluetooth mouse", bluetoothMouseEnabled ? "enabled" : "disabled");

        return;
    }

    if (bluetoothKeyboardEnabled) {
        remotePressedKeys = keys;
        updateKeys();
        return;
    }

    broadcastKeys(keys);
};

let oldButton = 0;
const mouseHandler = (buffer) => {

    if (bluetoothMouseEnabled) {
        send(buffer);
        return;
    }

    const { button, x, y, yScroll, xScroll } = decodeMouse(buffer);

    const posMsg = (x !== 0 || y !== 0) ? Buffer.from([0, toByte(x), toByte(y)]) : null;
    const otherMsg = (button !== oldButton || yScroll !== 0 || xScroll !== 0) ? Buffer.from([1, button, toByte(yScroll), toByte(xScroll)]) : null;

    for (const socket of mouseSockets) {
        try {
            if (posMsg) socket.write(posMsg);
            if (otherMsg) socket.write(otherMsg);
        } catch (error) {
        }
    }

    oldButton = button;
};

const connectKeyboard = async () => {

    console.log("Waiting for device...");

    let device = null;
    let hidraw = null;
    let events = null;
    while (true) {
        try {
            device = fs.readdirSync("/sys/bus/hid/devices")[0];
            hidraw = fs.readdirSync("/sys/bus/hid/devices/" + device + "/hidraw")[0];
            events = fs.readdirSync("/sys/bus/hid/devices/" + device + "/input");
        } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
        }
        break;
    }

    console.log("Found device", device);

    for (const event of events) {
        const inputEvents = fs.readdirSync("/sys/bus/hid/devices/" + device + "/input/" + event).filter((inputEvent) => inputEvent.startsWith("event"));
        for (const inputEvent of inputEvents) {
            console.log("Grabbing", inputEvent);
            ioctl(fs.openSync("/dev/input/" + inputEvent, "r"), 0x40044590, 1);
        }
    }

    let oldPressedKeys = [];
    let oldPressedMedia = [];
    const stream = fs.createReadStream("/dev/" + hidraw, { flags: "r", highWaterMark: 64 });
    stream.on("data", (buffer) => {

        if (buffer[0] === 5) { // Mouse

            mouseHandler(buffer);

        } else if (buffer[0] === 1) { // Keyboard

            const keys = decodeKeys(buffer, keymap);
            if (!keys) return;
            oldPressedKeys = keys.concat(decodeModifiers(buffer[1], keymap.modifiers));

            keyboardHandler(oldPressedKeys.concat(oldPressedMedia));

        } else if (buffer[0] === 2) { // Media

            oldPressedMedia = decodeModifiers(buffer[1], keymap.media1).concat(decodeModifiers(buffer[2], keymap.media2)).concat(decodeModifiers(buffer[3], keymap.media3));

            keyboardHandler(oldPressedKeys.concat(oldPressedMedia));
        }
    });
    stream.on("close", () => {
        console.log("Device disconnected");
        connectKeyboard();
    });
    stream.on("error", () => { });
};

connectKeyboard();
