import {EventEmitter} from "events";
import {PacketType} from "socket.io-parser";
import hasBin from "has-binary2";
import url from "url";
import debugModule from "debug";
import {Client, Namespace, Server} from "./index";
import {IncomingMessage} from "http";
import {Adapter, BroadcastFlags, Room, SocketId} from "socket.io-adapter";

const debug = debugModule("socket.io:socket");

/**
 * Blacklisted events.黑名单列表事件
 */

const events = [
    "error",
    "connect",
    "disconnect",
    "disconnecting",
    "newListener",
    "removeListener"
];

/**
 * The handshake details，握手详情
 */
export interface Handshake {
    /**
     * The headers sent as part of the handshake，握手请求头
     */
    headers: object;

    /**
     * The date of creation (as string)，创建日期时间
     */
    time: string;

    /**
     * The ip of the client，客户端ip地址
     */
    address: string;

    /**
     * Whether the connection is cross-domain，是否连接跨域
     */
    xdomain: boolean;

    /**
     * Whether the connection is secure，连接是否安全
     */
    secure: boolean;

    /**
     * The date of creation (as unix timestamp)
     */
    issued: number;

    /**
     * The request URL string，请求url
     */
    url: string;

    /**
     * The query object，查询参数对象
     */
    query: object;
}

// 这个类代码客户端虚拟连接，一个Socket对象必属于某个命名空间对象且复用Client底层连接
export class Socket extends EventEmitter {
    public readonly id: SocketId; // 命名空间名称和客户端id的组合
    public readonly handshake: Handshake; // 握手协议内容

    public connected: boolean; // 是否已经连接
    public disconnected: boolean; // 是否已经断开

    private readonly server: Server; // 服务器对象
    private readonly adapter: Adapter; // 适配器对象，来自命名空间
    private acks: Map<number, () => void> = new Map(); // 需要确认消息的列表
    // 这个中间件是在连接建立的回调函数中注册的，拦截的是连接以后的自定义事件
    private fns: Array<(event: Array<any>, next: (err: Error) => void) => void> = []; // 中间件函数
    private flags: BroadcastFlags = {}; // 消息标记
    private _rooms: Set<Room> = new Set(); // 该Socket连接加入的房间集合，默认一定会加入SocketId房间

    /**
     * Interface to a `Client` for a given `Namespace`.
     * 为给定命名空间的客户端连接
     *
     * @param {Namespace} nsp
     * @param {Client} client
     * @param {Object} query
     * @package
     */
    constructor(readonly nsp: Namespace, readonly client: Client, query) {
        super();
        this.server = nsp.server; // 服务器对象
        this.adapter = this.nsp.adapter; // 适配器对象
        // 如果不是默认命名空间，则需要把命名空间名称作为前缀
        this.id = nsp.name !== "/" ? nsp.name + "#" + client.id : client.id;
        this.connected = true; // 表示已经建立连接
        this.disconnected = false; // 表示是否已经断开连接
        this.handshake = this.buildHandshake(query); // 保存握手对象
    }

    /**
     * Builds the `handshake` BC object，构建握手对象
     */
    private buildHandshake(query): Handshake {
        const self = this;

        // 构建请求参数
        function buildQuery() {
            // 获取请求参数
            const requestQuery = url.parse(self.request.url, true).query;
            //if socket-specific query exist, replace query strings in requestQuery
            return Object.assign({}, query, requestQuery);
        }

        return {
            headers: this.request.headers, // 请求头
            time: new Date() + "", // 创建日期
            address: this.conn.remoteAddress, // 客户端ip地址
            xdomain: !!this.request.headers.origin, // 连接是否跨域
            // @ts-ignore
            secure: !!this.request.connection.encrypted, // 是否是安全连接
            issued: +new Date(), // 创建日期
            url: this.request.url, // 请求url地址
            query: buildQuery() // 查询对象
        };
    }

    /**
     * Emits to this client.发送消息给客户端
     *
     * @return {Socket} self
     */
    // @ts-ignore
    public emit(ev) {
        if (~events.indexOf(ev)) { // 过滤父对象发出的事件
            super.emit.apply(this, arguments);
            return this;
        }

        const args = Array.prototype.slice.call(arguments);
        const packet: any = {
            type: (this.flags.binary !== undefined
                ? this.flags.binary
                : hasBin(args))
                ? PacketType.BINARY_EVENT
                : PacketType.EVENT,
            data: args
        };

        // access last argument to see if it's an ACK callback
        // 如果最后一个参数是确认回调函数
        if (typeof args[args.length - 1] === "function") {
            if (this._rooms.size || this.flags.broadcast) {
                throw new Error("Callbacks are not supported when broadcasting");
            }

            debug("emitting packet with ack id %d", this.nsp.ids);
            this.acks.set(this.nsp.ids, args.pop()); // 加入到确认回调列表中
            packet.id = this.nsp.ids++;
        }

        const rooms = new Set(this._rooms); // 获取当前命名空间的所有房间对象
        const flags = Object.assign({}, this.flags);

        // reset flags
        this._rooms.clear();
        this.flags = {};

        if (rooms.size || flags.broadcast) { // 广播
            // 调用适配器广播方法
            this.adapter.broadcast(packet, {
                except: new Set([this.id]), // 需要排除当前连接
                rooms: rooms,
                flags: flags
            });
        } else { // 发送给指定用户
            // dispatch packet
            this.packet(packet, flags);
        }
        return this;
    }

    /**
     * Targets a room when broadcasting.广播的目标房间，可以调用多次来指定多个房间
     *
     * @param {String} name
     * @return {Socket} self
     */
    public to(name: Room) {
        this._rooms.add(name);
        return this;
    }

    /**
     * Targets a room when broadcasting.广播的目标房间，可以调用多次来指定多个房间
     *
     * @param {String} name
     * @return {Socket} self
     */
    public in(name: Room): Socket {
        this._rooms.add(name);
        return this;
    }

    /**
     * Sends a `message` event.发送一个message事件
     * 这是emit的简化方法，自动发送message事件
     *
     * @return {Socket} self
     */
    public send(...args): Socket {
        args.unshift("message");
        this.emit.apply(this, args);
        return this;
    }

    /**
     * Sends a `message` event.发送一个message事件
     * 这是emit的简化方法，自动发送message事件
     *
     * @return {Socket} self
     */
    public write(...args): Socket {
        args.unshift("message");
        this.emit.apply(this, args);
        return this;
    }

    /**
     * Writes a packet.写入一个包到底层传输通道
     *
     * @param {Object} packet - packet object
     * @param {Object} opts - options
     */
    private packet(packet, opts: any = {}) {
        packet.nsp = this.nsp.name; // 每个包都需要命名空间
        opts.compress = false !== opts.compress;
        this.client.packet(packet, opts);
    }

    /**
     * Joins a room.加入一个或多个房间
     *
     * @param {String|Array} rooms - room or array of rooms
     * @param {Function} fn - optional, callback
     * @return {Socket} self
     */
    public join(rooms: Room | Array<Room>, fn?: (err: Error) => void): Socket {
        debug("joining room %s", rooms);

        this.adapter.addAll(
            this.id, // 注意是socket id，一般带命名空间前缀
            new Set(Array.isArray(rooms) ? rooms : [rooms])
        );
        debug("joined room %s", rooms);
        fn && fn(null); // 执行回调函数
        return this;
    }

    /**
     * Leaves a room.离开房间
     *
     * @param {String} room
     * @param {Function} fn - optional, callback
     * @return {Socket} self
     */
    public leave(room: string, fn?: (err: Error) => void): Socket {
        debug("leave room %s", room);
        this.adapter.del(this.id, room);

        debug("left room %s", room);
        fn && fn(null); // 执行回调函数

        return this;
    }

    /**
     * Leave all rooms.离开所有房间
     */
    private leaveAll(): void {
        this.adapter.delAll(this.id);
    }

    /**
     * Called by `Namespace` upon successful
     * middleware execution (ie: authorization).
     * Socket is added to namespace array before
     * call to join, so adapters can access it.
     * 在成功执行中间件（即：授权）时，由“Namespace”调用。
     * Socket在调用join之前被添加到名称空间数组，因此适配器可以访问它。
     *
     * @package
     */
    public onconnect(): void {
        debug("socket connected - writing packet");
        // 建立socket id与Socket映射关系
        this.nsp.connected.set(this.id, this);
        this.join(this.id); // 默认加入以socket id为名称的房间
        // 如果是默认命名空间且没有中间件，则前面已经响应连接包，用来通知客户端连接成功
        const skip = this.nsp.name === "/" && this.nsp.fns.length === 0;
        if (skip) { // 这里不需要再次发送
            debug("packet already sent in initial handshake");
        } else { // 中间件执行成功，则需要响应一个连接包，用来通知客户端连接成功
            this.packet({type: PacketType.CONNECT});
        }
    }

    /**
     * Called with each packet. Called by `Client`.
     * 传入数据包来调用。 由“Client”调用。
     *
     * @param {Object} packet
     * @package
     */
    public onpacket(packet) {
        debug("got packet %j", packet);
        switch (packet.type) {
            case PacketType.EVENT: // 传输不带二进制数据的消息
                this.onevent(packet);
                break;

            case PacketType.BINARY_EVENT: // 传输带二进制数据的消息
                this.onevent(packet);
                break;

            case PacketType.ACK: // 对前一个发出的数据包的确认，它的负载不包含二进制数据
                this.onack(packet);
                break;

            case PacketType.BINARY_ACK: // 对前一个发出的数据包的确认，它的负载包含二进制数据
                this.onack(packet);
                break;

            case PacketType.DISCONNECT: // 断开与某个命名空间连接
                this.ondisconnect();
                break;

            case PacketType.ERROR: // 连接到命名空间被拒绝发出该事件
                this.onerror(new Error(packet.data));
        }
    }

    /**
     * Called upon event packet.调用事件包。
     *
     * @param {Object} packet - packet object
     */
    private onevent(packet): void {
        const args = packet.data || [];
        debug("emitting event %j", args);

        if (null != packet.id) { // 如果存在确认id，说明该消息需要确认，则需要发送确认包
            debug("attaching ack callback to event");
            args.push(this.ack(packet.id)); // 创建一个确认回调函数，注意确认回调函数在参数的末尾
        }

        this.dispatch(args);
    }

    /**
     * Produces an ack callback to emit with an event.
     * 产生一个ack回调以与事件一起发出。
     *
     * @param {Number} id - packet id
     */
    private ack(id: number) {
        const self = this;
        let sent = false;
        return function () {
            // prevent double callbacks
            if (sent) return;
            const args = Array.prototype.slice.call(arguments); // 获取传入函数参数
            debug("sending ack %j", args);

            // 发送一个确认包
            self.packet({
                id: id,
                type: hasBin(args) ? PacketType.BINARY_ACK : PacketType.ACK,
                data: args
            });

            sent = true;
        };
    }

    /**
     * Called upon ack packet.收到ack数据包时调用。是客户端对收到消息包的确认
     */
    private onack(packet): void {
        const ack = this.acks.get(packet.id);
        if ("function" == typeof ack) {
            debug("calling ack %s with %j", packet.id, packet.data);
            ack.apply(this, packet.data); // 调用回调函数
            this.acks.delete(packet.id); // 删除已经确认包的回调函数
        } else {
            debug("bad ack %s", packet.id);
        }
    }

    /**
     * Called upon client disconnect packet.收到disconnect数据包时调用。
     */
    private ondisconnect(): void {
        debug("got disconnect packet");
        this.onclose("client namespace disconnect");
    }

    /**
     * Handles a client error.处理客户端错误
     *
     * @package
     */
    public onerror(err): void {
        if (this.listeners("error").length) {
            super.emit("error", err); // 发出error事件
        } else {
            console.error("Missing error handler on `socket`.");
            console.error(err.stack);
        }
    }

    /**
     * Called upon closing. Called by `Client`.
     * 这个关闭仅仅是关闭Socket虚拟连接，不会关闭底层连接。
     *
     * @param {String} reason
     * @throw {Error} optional error object
     *
     * @package
     */
    public onclose(reason: string) {
        if (!this.connected) return this;
        debug("closing socket - reason %s", reason);
        super.emit("disconnecting", reason); // 发出disconnecting事件
        this.leaveAll(); // 离开所有加入的房间
        this.nsp.remove(this);
        this.client.remove(this);
        this.connected = false;
        this.disconnected = true;
        this.nsp.connected.delete(this.id);
        super.emit("disconnect", reason); // 发出disconnect事件
    }

    /**
     * Produces an `error` packet.产生一个error类型包
     *
     * @param {Object} err - error object
     *
     * @package
     */
    public error(err) {
        this.packet({type: PacketType.ERROR, data: err});
    }

    /**
     * Disconnects this client.与命名空间断开连接,默认不关闭底层连接
     *
     * @param {Boolean} close - if `true`, closes the underlying connection 如果为true，则断开底层连接
     * @return {Socket} self
     */
    public disconnect(close = false): Socket {
        if (!this.connected) return this;
        if (close) {
            this.client.disconnect(); // 会关闭底层连接
        } else {
            // 发送断开与命名空间连接包，底层连接不会关闭
            this.packet({type: PacketType.DISCONNECT});
            this.onclose("server namespace disconnect");
        }
        return this;
    }

    /**
     * Sets the compress flag.设置压缩标记
     *
     * @param {Boolean} compress - if `true`, compresses the sending data
     * @return {Socket} self
     */
    public compress(compress: boolean): Socket {
        this.flags.compress = compress;
        return this;
    }

    /**
     * Sets the binary flag，设置二进制标记
     *
     * @param {Boolean} binary - encode as if it has binary data if `true`, Encode as if it doesnt have binary data if `false`
     * @return {Socket} self
     */
    public binary(binary: boolean): Socket {
        this.flags.binary = binary;
        return this;
    }

    /**
     * Sets a modifier for a subsequent event emission that the event data may be lost if the client is not ready to
     * receive messages (because of network slowness or other issues, or because they’re connected through long polling
     * and is in the middle of a request-response cycle).
     * 需要进一步研究使用场景？？
     *
     * @return {Socket} self
     */
    public get volatile(): Socket {
        this.flags.volatile = true;
        return this;
    }

    /**
     * Sets a modifier for a subsequent event emission that the event data will only be broadcast to every sockets but the
     * sender.排除当前连接的广播标记
     *
     * @return {Socket} self
     */
    public get broadcast(): Socket {
        this.flags.broadcast = true;
        return this;
    }

    /**
     * Sets a modifier for a subsequent event emission that the event data will only be broadcast to the current node.仅在当前节点服务器广播
     *
     * @return {Socket} self
     */
    public get local(): Socket {
        this.flags.local = true;
        return this;
    }

    /**
     * Dispatch incoming event to socket listeners.分发接收的事件给事件监听器
     *
     * @param {Array} event - event that will get emitted
     */
    private dispatch(event: Array<string>): void {
        debug("dispatching an event %j", event);
        this.run(event, err => {
            process.nextTick(() => {
                if (err) {
                    return this.error(err.message);
                }
                super.emit.apply(this, event); // 执行中间件然后触发指定事件
            });
        });
    }

    /**
     * Sets up socket middleware.设置socket中间件
     *
     * @param {Function} fn - middleware function (event, next)
     * @return {Socket} self
     */
    public use(
        fn: (event: Array<any>, next: (err: Error) => void) => void
    ): Socket {
        this.fns.push(fn);
        return this;
    }

    /**
     * Executes the middleware for an incoming event.为接收的事件执行中间件
     *
     * @param {Array} event - event that will get emitted
     * @param {Function} fn - last fn call in the middleware 中间件中最后一个被调用函数
     */
    private run(event: Array<any>, fn: (err: Error) => void) {
        const fns = this.fns.slice(0);
        if (!fns.length) return fn(null);

        function run(i) {
            fns[i](event, function (err) {
                // upon error, short-circuit
                if (err) return fn(err);

                // if no middleware left, summon callback
                if (!fns[i + 1]) return fn(null);

                // go on to next
                run(i + 1);
            });
        }

        run(0);
    }

    // 获取接收的请求对象
    public get request(): IncomingMessage {
        return this.client.request;
    }

    // 获取底层真实的连接对象
    public get conn() {
        return this.client.conn;
    }

    // 获取当前连接所在房间号，分布式节点情况，可能需要查询其它节点
    public get rooms(): Set<Room> {
        return this.adapter.socketRooms(this.id) || new Set();
    }
}
