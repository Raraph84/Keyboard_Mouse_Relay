const { fromByte } = require("../server/utils");
const net = require("net");
const provider = process.platform === "win32" ? require("../libnut-core") : require("robotjs");

require("dotenv").config();

provider.setMouseDelay(0);

const mouseSpeed = 1.1;

let lastButton = null;
const handle = (data) => {

    if (data[0] === 0) {

        const x = fromByte(data[1]) * mouseSpeed;
        const y = fromByte(data[2]) * mouseSpeed;

        const old = provider.getMousePos();
        provider.moveMouse(old.x + x, old.y + y);

    } else if (data[0] === 1) {

        const button = { 1: "left", 2: "right", 4: "middle" }[data[1]];
        if (button && lastButton !== button) {
            if (lastButton) provider.mouseToggle("up", lastButton);
            provider.mouseToggle("down", button);
            lastButton = button;
        } else if (lastButton) {
            provider.mouseToggle("up", lastButton);
            lastButton = null;
        }

        if (data[2] || data[3]) {

            const yScroll = fromByte(data[2]);
            const xScroll = 0 - fromByte(data[3]);

            if (process.platform === "win32") provider.scrollMouse(xScroll * 144, yScroll * 144);
            else provider.scrollMouse(xScroll, yScroll);
        }
    }
};

const connect = () => {

    const client = new net.Socket();
    client.connect(process.env.SERVER_PORT, process.env.SERVER_HOST);
    client.on("connect", () => {
        client.write(JSON.stringify({ token: process.env.TOKEN, type: "mouse" }) + "\n");
        console.log("Connected to the server.");
    });
    client.on("close", () => {
        console.log("Disconnected from the server, reconnecting...");
        setTimeout(connect, 500);
    });
    client.on("error", () => { });

    let data = Buffer.alloc(0);
    let nextSize = 0;
    client.on("data", (chunk) => {
        data = Buffer.concat([data, chunk]);
        while (data.length && data.length >= (nextSize = { 0: 3, 1: 4 }[data[0]])) {
            handle(data.subarray(0, nextSize));
            data = data.subarray(nextSize);
        }
    });
};

connect();
