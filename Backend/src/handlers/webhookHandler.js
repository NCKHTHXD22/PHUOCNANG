const { sendZaloText } = require('../utils/zaloApi');
const CONFIG = require('../config');
const {
  promptReportApp,
  promptReportAppHistory,
  isFeedbackTrigger,
  isLookupTrigger,
} = require('../services/feedbackService');
const { saveProfile } = require('../admin/profileCache');
const { addGroup } = require('../admin/groupService');

async function handleWebhook(body) {
  const eventName = body.event_name;

  // Tự động lưu nhóm khi có thông tin group
  if (body.group?.id) {
    const groupId = String(body.group.id);
    const groupName = body.group.name || '';
    addGroup({ group_id: groupId, name: groupName })
      .then(() => console.log(`[Group] Auto-saved: ${groupId} "${groupName}"`))
      .catch(err => console.error('[Group] Auto-save error:', err.message));
  }

  if (eventName === 'oa_joined_group') {
    console.log(`[Group] OA được thêm vào nhóm: ${body.group?.id} "${body.group?.name}"`);
    return;
  }

  // Sự kiện vòng đời nhóm (GMF) → đồng bộ lại danh sách nhóm
  if (['create_group', 'delete_group'].includes(eventName)) {
    console.log(`[GroupSync] Webhook ${eventName} (group ${body.group?.id || body.group_id}) → lên lịch đồng bộ nhóm`);
    require('../services/groupSyncService').scheduleSyncDebounced();
    return;
  }

  // Sự kiện liên quan yêu cầu tham gia nhóm — danh sách chờ duyệt luôn lấy live từ Zalo
  // (listpendinginvite) ở trang Cài đặt nhóm nên các sự kiện này chỉ cần log để theo dõi.
  const GROUP_JOIN_REQUEST_EVENTS = [
    'user_request_join_group',        // có người mới gửi yêu cầu tham gia nhóm
    'react_request_join_group',       // tên thực tế Zalo trả khi bấm "Test" trên dashboard
    'accept_request_join_group',      // tên theo docs Zalo cho sự kiện "đã duyệt xong"
    'react_request_join_group_reject',
    'reject_request_join_group',
  ];
  if (GROUP_JOIN_REQUEST_EVENTS.includes(eventName)) {
    const groupId = body.group_id || body.group?.id;
    const rawUsers = body.users || [];
    const userIds = rawUsers.map((u) => (typeof u === 'string' ? u : u?.id)).filter(Boolean);
    console.log(`[GroupJoin] Webhook ${eventName}: groupId=${groupId}, ${userIds.length} user — xem/duyệt tại trang Cài đặt nhóm`);
    return;
  }

  // Sự kiện thành viên ra/vào nhóm
  if (['user_join_group', 'user_leave_group'].includes(eventName)) {
    const groupId = body.group?.id || body.group_id;
    const users = body.users || [];

    // Fallback nếu Zalo đổi lại cấu trúc
    if (!users.length) {
      const fallbackId = body.sender?.id || body.follower?.id || body.user?.id;
      if (fallbackId) users.push({ id: fallbackId });
    }

    console.log(`[GroupSync] Webhook ${eventName}: groupId=${groupId}, có ${users.length} user`);

    if (groupId && users.length > 0) {
      const { handleUserJoinGroup, handleUserLeaveGroup } = require('../services/groupSyncService');

      for (const u of users) {
        const uid = u.id;
        if (!uid) continue;

        if (eventName === 'user_join_group') {
          handleUserJoinGroup(groupId, uid, '', '').catch(e => console.error(e));
        } else {
          handleUserLeaveGroup(groupId, uid).catch(e => console.error(e));
        }
      }
    } else {
      console.warn('[GroupSync] Webhook thiếu groupId hoặc danh sách user rỗng! Không thể xử lý.');
    }
    return;
  }

  const userId = body.sender?.id || body.follower?.id;
  if (!userId) return;

  console.log(`[Event] ${eventName} | userId: ${userId}`);

  // Cache profile từ mọi sự kiện có sender info
  const displayName = body.sender?.display_name || body.follower?.display_name || '';
  const avatar = body.sender?.avatar || body.follower?.avatar || '';
  if (displayName) {
    saveProfile(userId, displayName, avatar).catch(() => {});
  }

  // Chào mừng khi follow OA
  if (eventName === 'follow') {
    await sendZaloText(userId,
      `Xin chào! Chào mừng bạn quan tâm OA ${CONFIG.ORG_NAME} 🏘️\n\n` +
      'Bạn có thể gửi phản ánh, góp ý tới chúng tôi bằng cách:\n' +
      '• Chọn mục "Gửi Phản ánh - Góp ý" trong menu bên dưới\n' +
      '• Hoặc nhắn tin: #phananh\n\n' +
      'Theo dõi tình trạng xử lý: nhắn #theodoi'
    );
    return;
  }

  // User gửi text hoặc bấm menu (submit_info) → gửi nút mở ReportApp
  let text = '';
  if (eventName === 'user_send_text') text = (body.message?.text || '').trim();
  if (eventName === 'user_submit_info') {
    text = (body.info?.action_payload || body.info?.action || body.info?.data || '').trim();
  }
  if (!text) return;

  if (isLookupTrigger(text)) {
    await promptReportAppHistory(userId);
    return;
  }
  if (isFeedbackTrigger(text)) {
    await promptReportApp(userId);
  }
}

module.exports = { handleWebhook };
