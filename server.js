// =====================================================
// SERVER NHÀ THÔNG MINH - Node.js + Socket.IO
// Hỗ trợ tự động phát hiện và quản lý thiết bị động
// =====================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,   // Tăng lên 60s để tránh ngắt kết nối sớm trên cloud
    pingInterval: 25000   // Giảm tần suất ping để phù hợp với Render free tier
});

// --- Lưu trữ trạng thái toàn bộ thiết bị ---
// danhSachThietBi[id] = { id, ten_hien_thi, loai_thiet_bi, trang_thai, don_vi, trang_thai_cau_hinh, ... }
let danhSachThietBi = {};

// --- Lịch sử log sự kiện (50 dòng gần nhất) ---
let nhatKySuKien = [];
function ghiLog(loai, noi_dung) {
    const entry = { loai, noi_dung, thoiGian: new Date().toLocaleTimeString('vi-VN') };
    nhatKySuKien.unshift(entry);
    if (nhatKySuKien.length > 50) nhatKySuKien.pop();
    io.emit('log_event', entry);
    console.log(`[${entry.thoiGian}][${loai}] ${noi_dung}`);
}

// --- Phục vụ file web ---
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- REST API: lấy danh sách thiết bị (dự phòng) ---
app.get('/api/devices', (req, res) => {
    res.json(Object.values(danhSachThietBi));
});

// --- Health check endpoint cho Render ---
app.get('/health', (req, res) => {
    res.json({ status: 'ok', devices: Object.keys(danhSachThietBi).length });
});

// =====================================================
// XỬ LÝ KẾT NỐI SOCKET.IO
// =====================================================
io.on('connection', (socket) => {
    const clientIP = socket.handshake.address;
    ghiLog('KẾT NỐI', `Client mới: ${socket.id} từ ${clientIP}`);

    // Gửi toàn bộ danh sách thiết bị + lịch sử log cho client vừa kết nối
    socket.emit('current_devices', Object.values(danhSachThietBi));
    socket.emit('log_history', nhatKySuKien);

    // -------------------------------------------------------
    // ESP32 đăng ký thiết bị lên server
    // Payload mẫu: { id, ten_hien_thi, loai_thiet_bi, don_vi?, trang_thai_cau_hinh }
    // loai_thiet_bi: "cong_tac" | "cam_bien" | "servo" | "bao_dong"
    // -------------------------------------------------------
    socket.on('register_device', (data) => {
        if (!data || !data.id) return;

        const isNew = !danhSachThietBi[data.id];

        // Giữ lại trạng thái cũ nếu thiết bị đã tồn tại (tránh mất tên đã cấu hình)
        if (!isNew) {
            data = { ...data, ...danhSachThietBi[data.id], ...data };
        }

        danhSachThietBi[data.id] = {
            id: data.id,
            ten_hien_thi: data.ten_hien_thi || 'Chưa xác định',
            loai_thiet_bi: data.loai_thiet_bi || 'cong_tac',
            don_vi: data.don_vi || '',
            trang_thai: data.trang_thai !== undefined ? data.trang_thai : 'OFF',
            trang_thai_cau_hinh: data.trang_thai_cau_hinh || 'unconfigured',
            lan_cuoi_cap_nhat: new Date().toISOString()
        };

        io.emit('device_registered', danhSachThietBi[data.id]);

        if (isNew) {
            ghiLog('THIẾT BỊ', `Phát hiện thiết bị mới: ${data.id}`);
        } else {
            ghiLog('THIẾT BỊ', `Thiết bị kết nối lại: ${data.ten_hien_thi || data.id}`);
        }
    });

    // -------------------------------------------------------
    // Web đặt tên và kích hoạt thiết bị mới
    // Payload: { id, ten, loai }
    // -------------------------------------------------------
    socket.on('setup_new_device', (data) => {
        if (!data || !danhSachThietBi[data.id]) return;

        danhSachThietBi[data.id].ten_hien_thi = data.ten;
        danhSachThietBi[data.id].loai_thiet_bi = data.loai || danhSachThietBi[data.id].loai_thiet_bi;
        danhSachThietBi[data.id].trang_thai_cau_hinh = 'configured';

        // Gửi lệnh lưu config xuống ESP32
        io.emit('save_config_to_hardware', data);
        // Cập nhật UI web
        io.emit('device_configured_success', danhSachThietBi[data.id]);

        ghiLog('CẤU HÌNH', `Đã đặt tên thiết bị [${data.id}] → "${data.ten}"`);
    });

    // -------------------------------------------------------
    // ESP32 cập nhật giá trị cảm biến / trạng thái relay
    // Payload: { id, value }
    // -------------------------------------------------------
    socket.on('update_state', (data) => {
        if (!data || !data.id) return;
        if (danhSachThietBi[data.id]) {
            danhSachThietBi[data.id].trang_thai = data.value;
            danhSachThietBi[data.id].lan_cuoi_cap_nhat = new Date().toISOString();
        }
        io.emit('state_changed', data);
    });

    // -------------------------------------------------------
    // Web gửi lệnh điều khiển thiết bị
    // Payload: { id, command }
    // -------------------------------------------------------
    socket.on('control_device', (data) => {
        if (!data || !data.id) return;
        ghiLog('ĐIỀU KHIỂN', `Lệnh [${data.command}] → thiết bị [${data.id}]`);
        io.emit('device_command', data);
    });

    // -------------------------------------------------------
    // Web xóa thiết bị khỏi danh sách
    // -------------------------------------------------------
    socket.on('delete_device', (data) => {
        if (!data || !danhSachThietBi[data.id]) return;
        const ten = danhSachThietBi[data.id].ten_hien_thi;
        delete danhSachThietBi[data.id];
        io.emit('device_deleted', { id: data.id });
        ghiLog('XÓA', `Đã xóa thiết bị: ${ten} (${data.id})`);
    });

    socket.on('disconnect', () => {
        ghiLog('NGẮT KẾT NỐI', `Client: ${socket.id}`);
    });
});

// =====================================================
// KEEP-ALIVE: Tự ping chính mình để Render free tier
// không ngủ sau 15 phút không có traffic
// =====================================================
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
    setInterval(() => {
        const url = `${RENDER_URL}/health`;
        fetch(url).catch(() => {}); // Bỏ qua lỗi nếu có
        console.log(`[KEEP-ALIVE] Ping ${url}`);
    }, 14 * 60 * 1000); // Ping mỗi 14 phút
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Máy chủ Nhà Thông Minh đang chạy!`);
    console.log(`   👉 Mở Web tại: http://localhost:${PORT}`);
    if (RENDER_URL) {
        console.log(`   🌐 URL công khai: ${RENDER_URL}`);
    }
    console.log(`   📡 ESP32 kết nối tới: ${RENDER_URL || 'http://<IP_CỦA_BẠN>:' + PORT}\n`);
});
