import { Decoder, Encoder, PacketType } from "socket.io-parser";
import url from "url";
import debugModule = require("debug");
import { IncomingMessage } from "http";
import { Server } from "./index";
import { Socket } from "./socket";
import { SocketId } from "socket.io-adapter";

const debug = debugModule("socket.io:client");

// 这个类代表客户端实例对象，一个客户端表示一个真实的连接，基于该连接创建很多复用它的Socket对象
export class Client {
  public readonly conn; // Engine.IO连接
  /** @package */
  public readonly id: string; // 连接id

  private readonly server; // SocketIO服务对象
  private readonly encoder: Encoder; // 加密器
  private readonly decoder: Decoder; // 解密器
  // 一个client连接被多个关联其它命名空间的socket复用，SocketId和Socket对象映射关系
  // 一个client连接总是关联到一个默认命令空间/
  private sockets: Map<SocketId, Socket> = new Map();
  // 命名空间名称和Socket对象映射关系
  private nsps: Map<string, Socket> = new Map();
  private connectBuffer: Array<string> = []; // 暂存连接请求

  /**
   * Client constructor.
   *
   * @param {Server} server instance
   * @param {Socket} conn
   * @package
   */
  constructor(server: Server, conn) {
    this.server = server; // SocketIO服务对象
    this.conn = conn; // 底层连接对象
    this.encoder = server.encoder; // socketIO协议编码
    this.decoder = new server.parser.Decoder();
    this.id = conn.id; // 保存连接id，客户端id来自底层连接id
    this.setup(); // 绑定函数到底层连接事件上
  }

  /**
   * @return the reference to the request that originated the Engine.IO connection
   * 对发起Engine.IO连接的请求的引用
   */
  public get request(): IncomingMessage {
    return this.conn.request;
  }

  /**
   * Sets up event listeners.
   */
  private setup() {
    this.onclose = this.onclose.bind(this);
    this.ondata = this.ondata.bind(this);
    this.onerror = this.onerror.bind(this);
    this.ondecoded = this.ondecoded.bind(this);

    // @ts-ignore
    this.decoder.on("decoded", this.ondecoded); // 监听解码事件
    this.conn.on("data", this.ondata); // 监听data事件
    this.conn.on("error", this.onerror); // 监听error事件
    this.conn.on("close", this.onclose); // 监听close事件
  }

  /**
   * Connects a client to a namespace.将客户端连接到名称空间。
   *
   * @param {String} name namespace
   * @param {Object} query the query parameters
   * @package
   */
  public connect(name, query = {}) {
    if (this.server.nsps.has(name)) { // 检查该命名空间是否存在，存在则开始建立连接
      debug("connecting to namespace %s", name);
      return this.doConnect(name, query);
    }

    // 如果不存在该命名空间，则检查动态命名空间，如果匹配，则创建该命名空间
    this.server.checkNamespace(name, query, dynamicNsp => {
      if (dynamicNsp) { // 创建成功，则执行连接
        debug("dynamic namespace %s was created", dynamicNsp.name);
        this.doConnect(name, query);
      } else { // 创建失败，则返回错误包
        debug("creation of namespace %s was denied", name);
        this.packet({
          type: PacketType.ERROR,
          nsp: name,
          data: "Invalid namespace"
        });
      }
    });
  }

  /**
   * Connects a client to a namespace.
   * 连接一个客户端到命名空间。
   *
   * @param {String} name namespace
   * @param {String} query the query parameters
   */
  private doConnect(name, query) {
    const nsp = this.server.of(name); // 获取命名空间对象

    // 如果请求连接的不是默认命名空间，且当前不存在默认命名空间连接，则不能创建该连接？？
    if ("/" != name && !this.nsps.has("/")) {
      this.connectBuffer.push(name); // 把该命名空间暂存
      return;
    }

    // 给命名空间添加连接
    const socket = nsp.add(this, query, () => {
      this.sockets.set(socket.id, socket);
      this.nsps.set(nsp.name, socket);

      // 如果是默认命名空间且存在暂存未创建命名空间，则开始重新建立连接
      if ("/" == nsp.name && this.connectBuffer.length > 0) {
        this.connectBuffer.forEach(this.connect, this);
        this.connectBuffer = []; // 清空
      }
    });
  }

  /**
   * Disconnects from all namespaces and closes transport.
   *
   * @package
   */
  public disconnect() {
    for (const socket of this.sockets.values()) {
      socket.disconnect(); // 关闭所有虚拟连接
    }
    this.sockets.clear();
    this.close(); // 关闭底层连接
  }

  /**
   * Removes a socket. Called by each `Socket`.
   * 移除一个复用client连接的socket对象
   *
   * @package
   */
  public remove(socket: Socket) {
    if (this.sockets.has(socket.id)) {
      const nsp = this.sockets.get(socket.id).nsp.name;
      this.sockets.delete(socket.id);
      this.nsps.delete(nsp);
    } else {
      debug("ignoring remove for %s", socket.id);
    }
  }

  /**
   * Closes the underlying connection.
   */
  private close() {
    if ("open" == this.conn.readyState) {
      debug("forcing transport close");
      this.conn.close(); // 关闭底层连接
      this.onclose("forced server close");
    }
  }

  /**
   * Writes a packet to the transport.
   * 发送一个包到传输通道
   *
   * @param {Object} packet object
   * @param {Object} opts
   * @package
   */
  public packet(packet, opts?) {
    opts = opts || {};
    const self = this;

    // this writes to the actual connection
    function writeToEngine(encodedPackets) {
      if (opts.volatile && !self.conn.transport.writable) return;
      for (let i = 0; i < encodedPackets.length; i++) {
        self.conn.write(encodedPackets[i], { compress: opts.compress });
      }
    }

    if ("open" == this.conn.readyState) { // 底层连接已经打开
      debug("writing packet %j", packet);
      if (!opts.preEncoded) { // 预编码
        // not broadcasting, need to encode
        writeToEngine(this.encoder.encode(packet)); // encode, then write results to engine
      } else { // 已经被编码过，就不要加密
        // a broadcast pre-encodes a packet
        writeToEngine(packet);
      }
    } else { // 底层连接没有打开，则忽略该包
      debug("ignoring packet write %j", packet);
    }
  }

  /**
   * Called with incoming transport data.
   * 当底层传输通道有数据时调用
   */
  private ondata(data) {
    // try/catch is needed for protocol violations (GH-1880)
    try {
      this.decoder.add(data); // 把数据传递给解码器
    } catch (e) {
      this.onerror(e); // 发送错误
    }
  }

  /**
   * Called when parser fully decodes a packet.
   * 当解析器完整解析一个包的时候调用
   */
  private ondecoded(packet) {
    // 如果是一个连接类型的包
    if (PacketType.CONNECT == packet.type) {
      this.connect( // 解析包的内容，进入建立连接流程
        url.parse(packet.nsp).pathname,
        url.parse(packet.nsp, true).query
      );
    } else { // 其它类型的包，则根据命名空间名称获取Socket对象
      const socket = this.nsps.get(packet.nsp);
      if (socket) {
        process.nextTick(function() {
          socket.onpacket(packet); // 根据事件不同，触发不同的事件回调
        });
      } else {
        debug("no socket for namespace %s", packet.nsp);
      }
    }
  }

  /**
   * Handles an error.
   * 发生错误时调用
   *
   * @param {Object} err object
   */
  private onerror(err) {
    // 所有虚拟连接都要触发错误事件
    for (const socket of this.sockets.values()) {
      socket.onerror(err);
    }
    this.conn.close(); // 底层连接关闭
  }

  /**
   * Called upon transport close.
   * 在底层传输通道关闭的情况下调用
   *
   * @param reason
   */
  private onclose(reason: string) {
    debug("client close with reason %s", reason);

    // ignore a potential subsequent `close` event
    this.destroy(); // 解除所有监听器

    // `nsps` and `sockets` are cleaned up seamlessly
    for (const socket of this.sockets.values()) {
      socket.onclose(reason); // 触发所有虚拟连接相关事件
    }
    this.sockets.clear();

    this.decoder.destroy(); // clean up decoder
  }

  /**
   * Cleans up event listeners.
   * 清除事件监听器
   */
  private destroy() {
    this.conn.removeListener("data", this.ondata);
    this.conn.removeListener("error", this.onerror);
    this.conn.removeListener("close", this.onclose);
    // @ts-ignore
    this.decoder.removeListener("decoded", this.ondecoded);
  }
}
