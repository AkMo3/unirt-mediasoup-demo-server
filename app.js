import express from "express";
// import https from "httpolyglot";
import { createServer } from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";

import mediasoup from "mediasoup";

const __dirname = path.resolve();

const app = express();

app.get("/", (req, res) => {
  res.send("Hello from mediasoup app!");
});

app.use("/sfu", express.static(path.join(__dirname, "public")));

// const options = {
//   key: fs.readFileSync("./server/ssl/key.pem", "utf8"),
//   cert: fs.readFileSync("./server/ssl/cert.pem", "utf8"),
// };

// const httpsServer = https.createServer(options, app);
// httpsServer.listen(3000, () => {
//   console.log("Server is running on port 3000");
// });

const httpServer = createServer(app);
httpServer.listen(3001, () => {
  console.log("listening on port: " + 3001);
});

const wss = new WebSocketServer({ server: httpServer });

let worker;
let producerTransport;
let consumerTransport;
let producer;
let consumer;

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMaxPort: 2020,
    rtcMinPort: 2000,
  });

  console.log(`worker pid: ${worker.pid}`);

  worker.on("died", (err) => {
    console.error("Mediasoup worker died", err.message);
    setTimeout(() => process.exit(1), 2000);
  });
};

await createWorker();

const mediaCodecOptions = {
  audio: {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  vp8: {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
  "h264-42e01f": {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 3000,
    },
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
      { type: "transport-cc" },
    ],
  },
  "h264-4d001f": {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "4d001f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 3000,
    },
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
      { type: "transport-cc" },
    ],
  },
  "h264-svc": {
    kind: "video",
    mimeType: "video/H264-SVC",
    clockRate: 90000,
    parameters: {
      "level-asymmetry-allowed": 1,
    },
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
      { type: "transport-cc" },
    ],
  },
  "video/H265": {
    kind: "video",
    mimeType: "video/H265",
    clockRate: 90000,
    parameters: {
      "level-asymmetry-allowed": 1,
    },
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
      { type: "transport-cc" },
    ],
  },
};

const mediaCodecs = [
  mediaCodecOptions['audio'], mediaCodecOptions['vp8']
];

const router = await worker.createRouter({ mediaCodecs });

wss.on("connection", async function connection(socket) {
  let statInt;
  console.log(socket.id);
  socket.emit("connection-success", {
    socketId: socket.id,
  });

  socket.on("message", async function message(message) {
    console.log("received: %s", message);

    const { type, data } = JSON.parse(message);

    switch (type) {
      case "getRtpCapabilities":
        console.log("Getting router capabilities");
        const rtpCapabilities = router.rtpCapabilities;
        console.log("getRtpCapabilities: Fetching rtpCapabilities");
        const rtpCapabilitiesResponse = {
          rtpCapabilities: rtpCapabilities,
        };
        const responseData = JSON.stringify({
          type: "getRtpCapabilities",
          data: rtpCapabilitiesResponse,
        });
        socket.send(responseData);
        break;

      case "createWebRtcTransport":
        console.log("Creating WebRTC Transport");
        const params = await onCreateWebRtcTransport(data);
        const createWebRtcTransportResponseData = JSON.stringify({
          type: "createWebRtcTransport",
          data: params,
        });
        socket.send(createWebRtcTransportResponseData);
        break;

      case "createRecvWebRtcTransport":
        console.log("Creating Receiving WebRTC Transport");
        const dataRecv = await onCreateWebRtcTransport(data);
        const createRecvWebRtcTransportResponseData = JSON.stringify({
          type: "createRecvWebRtcTransport",
          data: dataRecv,
        });
        socket.send(createRecvWebRtcTransportResponseData);
        break;

      case "transport-connect":
        await producerTransport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        break;

      case "transport-recv-connect":
        await consumerTransport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        break;

      case "transport-produce":
        console.log("EVENT: Transport-produce");
        producer = await producerTransport.produce({
          kind: data.kind,
          rtpParameters: data.rtpParameters,
        });

        console.log(
          "Producer Id: ",
          producer.id,
          "Producer Kind: ",
          producer.kind
        );
        console.log("RTP Parameters: " + JSON.stringify(data.rtpParameters));

        producer.on("transportclose", () => {
          console.log("transport for this producer closed");
          producer.close();
        });

        socket.send(
          JSON.stringify({
            type: "transport-produce",
            data: { id: producer.id },
          })
        );
        break;

      case "consume":
        console.log("EVENT: consume");
        console.log(
          "RtpParameters received for consume: ",
          data.rtpCapabilities
        );

        const canConsume = router.canConsume({
          producerId: producer.id,
          rtpCapabilities: data.rtpCapabilities,
        });

        console.log(
          "rtpCapabilities",
          data.rtpCapabilities,
          " canConsume: ",
          canConsume
        );

        try {
          if (canConsume) {
            console.log("creating consumer");
            consumer = await consumerTransport.consume({
              producerId: producer.id,
              rtpCapabilities: data.rtpCapabilities,
              paused: true,
            });

            // await consumerTransport.enableTraceEvent([
            //   "bwe",
            //   "probation",
            // ]);
            // consumerTransport.on("trace", (trace) => {
            //   console.log("Sending Video Trace", { trace });
            // });

            consumer.on("transportclose", () => {
              console.log("transport close from consumer");
            });

            consumer.on("producerclose", () => {
              console.log("producer of consumer closed");
            });

            const params = {
              id: consumer.id,
              producerId: producer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
            };

            console.log(
              "RTP Parameters: ",
              JSON.stringify(consumer.rtpParameters)
            );

            socket.send(
              JSON.stringify({ type: "consume", data: { params: params } })
            );
          }
        } catch (error) {
          console.log(error.message);
          socket.send(
            JSON.stringify({
              type: "consume",
              data: {
                params: {
                  error: error,
                },
              },
            })
          );
        }
        break;

      case "consumer-resume":
        await consumer.resume();
        break;
    }

    // console.log({ rtpCapabilities });
  });

  socket.on("getRtpCapabilities", () => {
    console.log("Getting router capabilities");
    const rtpCapabilities = router.rtpCapabilities;
    console.log("getRtpCapabilities: Fetching rtpCapabilities");
    // callback({ rtpCapabilities });
    socket.emit("getRtpCapabilities", { rtpCapabilities });
  });

  const onCreateWebRtcTransport = async ({ sender }) => {
    console.log(`Is this a sender request? ${sender}`);

    const { params, transport } = await createWebRtcTransport();

    if (sender) producerTransport = transport;
    else consumerTransport = transport;

    return params;
  };

  socket.on("transport-connect", async ({ transportId, dtlsParameters }) => {
    console.table({ transportId, dtlsParameters });
    console.log("DTLS PARAMS... ", JSON.stringify(dtlsParameters));

    await producerTransport.connect({ dtlsParameters });
  });

  socket.on(
    "transport-produce",
    async ({ transportId, kind, rtpParameters, appData }, callback) => {
      producer = await producerTransport.produce({
        kind,
        rtpParameters,
      });

      console.log(
        "Producer Id: ",
        producer.id,
        "Producer Kind: ",
        producer.kind
      );

      producer.on("transportclose", () => {
        console.log("transport for this producer closed");
        producer.close();
      });

      callback({ id: producer.id });
    }
  );

  socket.on(
    "transport-recv-connect",
    async ({ transportId, dtlsParameters }) => {
      console.log("DTLS Params: ", dtlsParameters);
      await consumerTransport.connect({ dtlsParameters });
    }
  );

  socket.on("consume", async ({ rtpCapabilities }, callback) => {
    console.log("received consume req");
    console.log(
      "rtpCapabilities",
      rtpCapabilities,
      "producer id: ",
      producer.id
    );
    const canConsume = router.canConsume({
      producerId: producer.id,
      rtpCapabilities,
    });

    console.log("canConsume", canConsume);
    try {
      if (canConsume) {
        console.log("creating consumer");
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        });

        consumer.on("transportclose", () => {
          console.log("transport close from consumer");
        });

        consumer.on("producerclose", () => {
          console.log("producer of consumer closed");
        });

        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };

        callback({ params });
      }
    } catch (error) {
      console.log(error.message);
      callback({
        params: {
          error: error,
        },
      });
    }
  });

  socket.on("consumer-resume", async () => {
    console.log("consumer resume");
    await consumer.resume();
  });
});

const createWebRtcTransport = async () => {
  try {
    const webRtcListenOptions = {
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: "127.0.0.1",
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    };

    let transport = await router.createWebRtcTransport(webRtcListenOptions);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("@close", () => {
      console.log("transport closed");
    });

    const params = {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };

    console.log("DTLS Parameters: " + JSON.stringify(transport.dtlsParameters));
    // console.log("createWebRtcTransport response: ", params);

    return { params, transport };
  } catch (error) {
    console.log(error);
    throw error;
  }
};
