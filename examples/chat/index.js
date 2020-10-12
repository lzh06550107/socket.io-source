// 配置express服务器
var express = require('express');
var app = express();
var path = require('path');
var server = require('http').createServer(app);
var io = require('socket.io')(server);
var port = process.env.PORT || 3000;

server.listen(port, () => {
    console.log('Server listening at port %d', port);
});

// 路由
app.use(express.static(path.join(__dirname, 'public')));

// 聊天室

var numUsers = 0; // 聊天室人数

io.on('connection', (socket) => {
    // 标识当前连接的用户是否已经被添加，该变量只会在用户连接后初始化
    var addedUser = false;

    // 当客户端发送new message事件时，触发该回调
    socket.on('new message', (data) => {
        // 广播给其它客户端new message事件并带上用户名称和消息内容
        socket.broadcast.emit('new message', {
            username: socket.username,
            message: data
        });
    });

    // 当客户端发来'add user'事件，则执行如下逻辑
    socket.on('add user', (username) => {
        // 如果用户名称已经保存，则直接返回
        if (addedUser) return;

        // 存储客户端用户名称到socket属性中，所以该属性生命周期是连接范围
        socket.username = username;
        ++numUsers;
        addedUser = true;
        // 发送用户登录事件到客户端，并带上当前聊天室人数
        socket.emit('login', {
            numUsers: numUsers
        });
        //  广播给其它客户端user joined事件并带上用户名称和当前聊天室总人数
        socket.broadcast.emit('user joined', {
            username: socket.username,
            numUsers: numUsers
        });
    });

    // 当客户端发送typing事件，则广播给其它客户端
    socket.on('typing', () => {
        socket.broadcast.emit('typing', {
            username: socket.username // 需要带上用户名称，用户名称和连接socket绑定
        });
    });

    // 当用户发送stop typing事件，则广播给其它客户端
    socket.on('stop typing', () => {
        socket.broadcast.emit('stop typing', {
            username: socket.username // 需要带上用户名称，用户名称和连接socket绑定
        });
    });

    // 当客户端断开连接，执行如下
    socket.on('disconnect', () => {
        if (addedUser) {
            --numUsers; // 聊天室人数减1

            // 向其它客户端广播user left事件，并带上用户名称和当前聊天室总人数
            socket.broadcast.emit('user left', {
                username: socket.username,
                numUsers: numUsers
            });
        }
    });
});
