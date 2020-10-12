import { Socket } from "./socket";
import { Server } from "./index";
import { Client } from "./client";
import { EventEmitter } from "events";
import { PacketType } from "socket.io-parser";
import hasBin from "has-binary2";
import debugModule from "debug";
import { Adapter, Room, SocketId } from "socket.io-adapter";

const debug = debugModule("socket.io:namespace");

/**
 * Blacklisted events.列入黑名单的事件。
 */

const events = [
  "connect", // for symmetry with client 与客户保持对称
  "connection",
  "newListener"
];

export class Namespace extends EventEmitter {
  public readonly name: string; // 命名空间名称
  // 连接到当前命名空间的连接，SocketId和Socket映射关系，这里是已经成功建立连接
  public readonly connected: Map<SocketId, Socket> = new Map();

  public adapter: Adapter; // 不同命名空间初始化各自的适配器对象，动态命名空间不存在该值

  /** @package */
  public readonly server;
  /** @package */ // 命名空间中间件，是在创建虚拟连接Socket的时候执行
  public fns: Array<(socket: Socket, next: (err: Error) => void) => void> = [];
  /** @package */
  public rooms: Set<Room> = new Set(); // 房间集合
  /** @package */
  public flags: any = {};
  /** @package */
  public ids: number = 0; // 该命名空间发出包的序号
  /** @package */
  public sockets: Map<SocketId, Socket> = new Map(); // 用来跟踪创建Socket对象，这里不一定成功建立连接

  /**
   * Namespace constructor.
   *
   * @param {Server} server instance
   * @param {string} name
   */
  constructor(server: Server, name: string) {
    super();
    this.server = server;
    this.name = name; // 命名空间名称
    this.initAdapter(); // 初始化此nsp的“适配器”
  }

  /**
   * Initializes the `Adapter` for this nsp.
   * Run upon changing adapter by `Server#adapter`
   * in addition to the constructor.
   * 初始化此nsp的“适配器”。
   * 除构造函数外，还可以通过Server＃adapter更改适配器。
   *
   * @package
   */
  public initAdapter(): void {
    // 创建适配器实例对象并传入当前命名空间对象
    this.adapter = new (this.server.adapter())(this);
  }

  /**
   * Sets up namespace middleware.设置命名空间中间件
   *
   * @return {Namespace} self
   */
  public use(
    fn: (socket: Socket, next: (err: Error) => void) => void
  ): Namespace {
    if (this.server.eio && this.name === "/") {
      debug("removing initial packet");
      delete this.server.eio.initialPacket; // 如果添加了中间件，就不能合并发送连接包
    }
    this.fns.push(fn);
    return this;
  }

  /**
   * Executes the middleware for an incoming client.
   * 为传入的客户端执行中间件。
   *
   * @param {Socket} socket - the socket that will get added 将添加的套接字
   * @param {Function} fn - last fn call in the middleware 中间件中的最后一个fn调用
   */
  private run(socket: Socket, fn: (err: Error) => void) {
    const fns = this.fns.slice(0);// 返回新的数组
    if (!fns.length) return fn(null);

    // 递归调用中间件
    function run(i) {
      fns[i](socket, function(err) {
        // upon error, short-circuit
        if (err) return fn(err);

        // if no middleware left, summon callback 如果没有中间件，召唤回调
        if (!fns[i + 1]) return fn(null);

        // go on to next
        run(i + 1);
      });
    }

    run(0);
  }

  /**
   * Targets a room when emitting.消息发送的目标房间，可以多次调用，发送给多个房间
   *
   * @param {String} name
   * @return {Namespace} self
   */
  public to(name: Room): Namespace {
    this.rooms.add(name);
    return this;
  }

  /**
   * Targets a room when emitting.消息发送的目标房间，可以多次调用，发送给多个房间
   *
   * @param {String} name
   * @return {Namespace} self
   */
  public in(name: Room): Namespace {
    this.rooms.add(name);
    return this;
  }

  /**
   * Adds a new client.添加一个客户端对象
   *
   * @return {Socket}
   */
  private add(client: Client, query, fn?: () => void): Socket {
    debug("adding socket to nsp %s", this.name);
    // 为命名空间创建一个虚拟连接
    const socket = new Socket(this, client, query);
    // 执行该命名空间的中间件
    this.run(socket, err => {
      process.nextTick(() => {
        // 如果底层连接已经建立
        if ("open" == client.conn.readyState) {
          if (err) return socket.error(err.message);

          // track socket，建立socketId和socket对象映射关系
          this.sockets.set(socket.id, socket);

          // it's paramount that the internal `onconnect` logic
          // fires before user-set events to prevent state order
          // violations (such as a disconnection before the connection
          // logic is complete)
          // 至关重要的是，内部“onconnect”逻辑会在用户设置事件之前触发，以防止违反状态顺序（例如，在连接逻辑完成之前断开连接）
          socket.onconnect();
          if (fn) fn(); // 调用回调

          // fire user-set events，连接建立成功，则触发连接事件
          super.emit("connect", socket); // 调用监听器并传入Socket对象
          super.emit("connection", socket);
        } else {
          debug("next called after client was closed - ignoring socket");
        }
      });
    });
    return socket;
  }

  /**
   * Removes a client. Called by each `Socket`.
   * 移除一个客户端
   *
   * @package
   */
  public remove(socket: Socket): void {
    if (this.sockets.has(socket.id)) {
      this.sockets.delete(socket.id);
    } else {
      debug("ignoring remove for %s", socket.id);
    }
  }

  /**
   * Emits to all clients.给该命名空间下的所有连接发送消息
   *
   * @return {Namespace} self
   */
  // @ts-ignore
  public emit(ev): Namespace {
    if (~events.indexOf(ev)) {
      super.emit.apply(this, arguments);
      return this;
    }
    // set up packet object
    const args = Array.prototype.slice.call(arguments);
    // 数据包
    const packet = {
      type: (this.flags.binary !== undefined
      ? this.flags.binary
      : hasBin(args))
        ? PacketType.BINARY_EVENT
        : PacketType.EVENT,
      data: args
    };

    if ("function" == typeof args[args.length - 1]) {
      throw new Error("Callbacks are not supported when broadcasting");
    }

    const rooms = new Set(this.rooms); // 收集房间
    const flags = Object.assign({}, this.flags); // 收集标记

    // reset flags，清空标记
    this.rooms.clear();
    this.flags = {};

    this.adapter.broadcast(packet, {
      rooms: rooms,
      flags: flags
    });

    return this;
  }

  /**
   * Sends a `message` event to all clients.
   *
   * @return {Namespace} self
   */
  public send(...args): Namespace {
    args.unshift("message");
    this.emit.apply(this, args);
    return this;
  }

  /**
   * Sends a `message` event to all clients.
   *
   * @return {Namespace} self
   */
  public write(...args): Namespace {
    args.unshift("message"); // 添加message事件到数组头
    this.emit.apply(this, args);
    return this;
  }

  /**
   * Gets a list of clients.获取客户端列表
   *
   * @return {Namespace} self
   */
  public allSockets(): Promise<Set<SocketId>> {
    if (!this.adapter) {
      throw new Error(
        "No adapter for this namespace, are you trying to get the list of clients of a dynamic namespace?"
      );
    }
    const rooms = new Set(this.rooms);
    this.rooms.clear();
    return this.adapter.sockets(rooms);
  }

  /**
   * Sets the compress flag.设置是否压缩标记
   *
   * @param {Boolean} compress - if `true`, compresses the sending data
   * @return {Namespace} self
   */
  public compress(compress: boolean): Namespace {
    this.flags.compress = compress;
    return this;
  }

  /**
   * Sets the binary flag。标记是否是二进制数据
   *
   * @param {Boolean} binary - encode as if it has binary data if `true`, Encode as if it doesnt have binary data if `false`
   * @return {Namespace} self
   */
  public binary(binary: boolean): Namespace {
    this.flags.binary = binary;
    return this;
  }

  /**
   * Sets a modifier for a subsequent event emission that the event data may be lost if the client is not ready to
   * receive messages (because of network slowness or other issues, or because they’re connected through long polling
   * and is in the middle of a request-response cycle).
   * 设置用于后续事件发射的修饰符，如果客户端未准备好接收消息（由于网络速度慢或其他问题，或者由于它们是通过长时间轮询连接的并且处于请求中间），则事件数据可能会丢失 -响应周期）。
   *
   * @return {Namespace} self
   */
  public get volatile(): Namespace {
    this.flags.volatile = true;
    return this;
  }

  /**
   * Sets a modifier for a subsequent event emission that the event data will only be broadcast to the current node.
   * 为后续事件发出设置修饰符，以使事件数据仅广播到当前节点。当使用分布式节点部署是使用。
   *
   * @return {Namespace} self
   */
  public get local(): Namespace {
    this.flags.local = true;
    return this;
  }
}
