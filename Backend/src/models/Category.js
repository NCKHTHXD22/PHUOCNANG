const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name:        { type: String, required: true },
  // Nhóm Zalo tiếp nhận phản ánh của danh mục — rỗng thì gửi vào nhóm mặc định ZALO_GROUP_ID
  zaloGroupId: { type: String, default: '' },
  icon:        { type: String, default: '' },
  order:       { type: Number, default: 0 },
});

module.exports = mongoose.model('Category', categorySchema);
