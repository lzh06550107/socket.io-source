$(function () {
    var FADE_TIME = 150; // ms，淡入时间
    var TYPING_TIMER_LENGTH = 400; // ms，输入间隔时间，超过该时间被认为输入结束
    // 预定义用户名称颜色列表
    var COLORS = [
        '#e21400', '#91580f', '#f8a700', '#f78b00',
        '#58dc00', '#287b00', '#a8f07a', '#4ae8c4',
        '#3b88eb', '#3824aa', '#a700ff', '#d300e7'
    ];

    // 初始化变量
    var $window = $(window);
    var $usernameInput = $('.usernameInput'); // 输入用户名称
    var $messages = $('.messages'); // 消息显示区域
    var $inputMessage = $('.inputMessage'); // 消息输入框

    var $loginPage = $('.login.page'); // 登录页面
    var $chatPage = $('.chat.page'); // 聊天室页面

    // 提示输入用户名称
    var username;
    // 连接是否建立
    var connected = false;
    // 用户是否正在输入
    var typing = false;
    // 最近一次输入时间
    var lastTypingTime;
    var $currentInput = $usernameInput.focus();

    var socket = io();

    // 显示聊天室当前人数的消息
    const addParticipantsMessage = (data) => {
        var message = '';
        if (data.numUsers === 1) {
            message += "there's 1 participant";
        } else {
            message += "there are " + data.numUsers + " participants";
        }
        log(message);
    }

    // 设置客户端用户名称
    const setUsername = () => {
        username = cleanInput($usernameInput.val().trim());

        // 如果用户名称有效
        if (username) {
            $loginPage.fadeOut(); // jQuery方法，使用淡出效果来隐藏一个登录页面
            $chatPage.show(); // 显示聊天室页面
            $loginPage.off('click');
            $currentInput = $inputMessage.focus();

            // 发送用户名称到服务端
            socket.emit('add user', username);
        }
    }

    // 发送对话消息
    const sendMessage = () => {
        var message = $inputMessage.val();
        // 防止在消息中包含html标签
        message = cleanInput(message);
        // 如果消息非空且已经建立连接
        if (message && connected) {
            $inputMessage.val(''); // 清空消息
            addChatMessage({
                username: username, // 当前用户名称
                message: message // 当前用户发送消息
            });
            // tell server to execute 'new message' and send along one parameter
            socket.emit('new message', message);
        }
    }

    // 显示消息
    const log = (message, options) => {
        var $el = $('<li>').addClass('log').text(message);
        addMessageElement($el, options);
    }

    // 将消息添加到本地消息列表
    const addChatMessage = (data, options) => {
        // 如果已经存在该输入的用户
        var $typingMessages = getTypingMessages(data);
        options = options || {};
        if ($typingMessages.length !== 0) { // 存在正在输入的该用户
            options.fade = false;
            $typingMessages.remove(); // 清除
        }

        var $usernameDiv = $('<span class="username"/>')
            .text(data.username)
            .css('color', getUsernameColor(data.username));
        var $messageBodyDiv = $('<span class="messageBody">')
            .text(data.message);

        var typingClass = data.typing ? 'typing' : '';
        var $messageDiv = $('<li class="message"/>')
            .data('username', data.username)
            .addClass(typingClass)
            .append($usernameDiv, $messageBodyDiv);

        addMessageElement($messageDiv, options); // 添加消息到dom
    }

    // 响应服务器事件添加其它用户正在输入的提示
    const addChatTyping = (data) => {
        data.typing = true;
        data.message = 'is typing';
        addChatMessage(data);
    }

    // 响应服务器事件剔除用户正在输入的提示
    const removeChatTyping = (data) => {
        getTypingMessages(data).fadeOut(function () {
            $(this).remove();
        });
    }

    // 添加消息元素到dom并滚动到底部
    // el - 添加消息的元素对象
    // options.fade - 是否元素应该淡入(默认为true)
    // options.prepend - 是否元素应该追加在其它消息后面(默认为false)
    const addMessageElement = (el, options) => {
        var $el = $(el);

        if (!options) {
            options = {};
        }
        if (typeof options.fade === 'undefined') {
            options.fade = true; // 是否显示
        }
        if (typeof options.prepend === 'undefined') {
            options.prepend = false;
        }

        if (options.fade) {
            $el.hide().fadeIn(FADE_TIME); // 设置淡入动画
        }
        if (options.prepend) { // 追加到消息末尾
            $messages.prepend($el);
        } else {
            $messages.append($el); // 放在消息头部
        }
        // 滚动到底部
        $messages[0].scrollTop = $messages[0].scrollHeight;
    }

    // 防止在消息中包含html标签
    const cleanInput = (input) => {
        return $('<div/>').text(input).html();
    }

    // 发送typing事件
    const updateTyping = () => {
        if (connected) { // 如果已经连接
            if (!typing) { // 如果用户没有输入，则直接发送typing事件到服务器
                typing = true;
                socket.emit('typing');
            }
            lastTypingTime = (new Date()).getTime();

            // 如果在指定时间长度没有输入，则发送stop typing事件到服务器
            setTimeout(() => {
                var typingTimer = (new Date()).getTime();
                var timeDiff = typingTimer - lastTypingTime;
                if (timeDiff >= TYPING_TIMER_LENGTH && typing) {
                    socket.emit('stop typing');
                    typing = false;
                }
            }, TYPING_TIMER_LENGTH);
        }
    }

    // 获取当前正在输入消息的用户，返回jquery对象
    const getTypingMessages = (data) => {
        return $('.typing.message').filter(function (i) {
            return $(this).data('username') === data.username;
        });
    }

    // 通过哈希函数来获取用户名称的颜色
    const getUsernameColor = (username) => {
        // 计算哈希值
        var hash = 7;
        for (var i = 0; i < username.length; i++) {
            hash = username.charCodeAt(i) + (hash << 5) - hash;
        }
        // 计算颜色
        var index = Math.abs(hash % COLORS.length);
        return COLORS[index];
    }

    // 键盘事件

    $window.keydown(event => {
        if (!(event.ctrlKey || event.metaKey || event.altKey)) {
            $currentInput.focus();
        }

        if (event.which === 13) { // 如果点击回车键
            if (username) { // 如果用户登录，则可以发送消息
                sendMessage(); // 本地显示消息
                socket.emit('stop typing'); // 发送用户停止输入事件
                typing = false;
            } else {
                setUsername(); // 添加用户
            }
        }
    });

    // 用户输入触发typing事件
    $inputMessage.on('input', () => {
        updateTyping();
    });

    // 点击事件

    // 在登录页面任何地方点击会让输入框获取焦点
    $loginPage.click(() => {
        $currentInput.focus();
    });

    // 输入消息框被点击后会获取输入焦点
    $inputMessage.click(() => {
        $inputMessage.focus();
    });

    // Socket 事件

    // 当服务器端返回login事件，记录login事件消息
    socket.on('login', (data) => {
        connected = true;
        // 显示欢迎消息
        var message = "Welcome to Socket.IO Chat – ";
        // 显示消息
        log(message, {
            prepend: true // 消息是追加模式
        });
        addParticipantsMessage(data);
    });

    // 当收到服务器的new message事件时，更新聊天室记录
    socket.on('new message', (data) => {
        addChatMessage(data);
    });

    // 当收到服务器的user joined事件时，在聊天室显示该消息
    socket.on('user joined', (data) => {
        log(data.username + ' joined');
        addParticipantsMessage(data);
    });

    // 当收到服务器的user left事件时，在聊天室显示该消息
    socket.on('user left', (data) => {
        log(data.username + ' left');
        addParticipantsMessage(data);
        removeChatTyping(data);
    });

    // 当服务器发送typing事件时，显示输入消息提示
    socket.on('typing', (data) => {
        addChatTyping(data);
    });

    // 当服务器发送stop typing事件时，隐藏输入消息提示
    socket.on('stop typing', (data) => {
        removeChatTyping(data);
    });

    // 客户端连接断开
    socket.on('disconnect', () => {
        log('you have been disconnected');
    });

    // 客户端重新连接
    socket.on('reconnect', () => {
        log('you have been reconnected');
        if (username) { // 如果用户已经登录，则需要重新发送add user来在服务器端添加该用户
            socket.emit('add user', username);
        }
    });

    // 客户端重新连接错误
    socket.on('reconnect_error', () => {
        log('attempt to reconnect has failed');
    });

});
