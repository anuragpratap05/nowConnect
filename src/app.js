const express = require("express");
const connectDB = require("./config/database");
const app = express();
const cookieParser = require("cookie-parser");
const cors = require("cors");
const http = require("http");

require("dotenv").config();

require("./utils/cronjob");

app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

const authRouter = require("./routes/auth");
const profileRouter = require("./routes/profile");
const requestRouter = require("./routes/request");
const userRouter = require("./routes/user");
// const paymentRouter = require("./routes/payment");
const initializeSocket = require("./utils/socket");
const chatRouter = require("./routes/chat");
const postRouter = require("./routes/post");

app.use("/", authRouter);
app.use("/", profileRouter);
app.use("/", requestRouter);
app.use("/", userRouter);
// app.use("/", paymentRouter);
app.use("/", chatRouter);
app.use("/", postRouter);

const server = http.createServer(app);

// Phase 3: re-enabled. Socket.io attaches to the same http server as Express, so
// there is one process and one port serving both the REST API and the WebSocket
// upgrade. Rooms are backed by the Redis adapter (see src/utils/socket.js), which
// is what makes running more than one of these processes actually work.
initializeSocket(server);

connectDB()
  .then(() => {
    console.log("Database connection established...");
    server.listen(process.env.PORT, () => {
      console.log(`Server is successfully listening on port ${process.env.PORT}...`);
    });
  })
  .catch((err) => {
    console.error("Database cannot be connected!!");
  });
