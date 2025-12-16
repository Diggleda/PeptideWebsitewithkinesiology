const { orderStore } = require('../storage');

const getAll = () => orderStore.read();

const findById = (id) => getAll().find((order) => order.id === id) || null;

const findByUserId = (userId) => getAll().filter((order) => order.userId === userId);

const findByUserIdAndIdempotencyKey = (userId, idempotencyKey) => {
  if (!userId || !idempotencyKey) {
    return null;
  }
  const orders = getAll();
  return orders.find((order) => order.userId === userId && order.idempotencyKey === idempotencyKey) || null;
};

const findByPaymentIntentId = (paymentIntentId) => getAll().find((order) => order.paymentIntentId === paymentIntentId) || null;

const insert = (order) => {
  const orders = getAll();
  const existing = orders.find((item) => item.id === order.id);
  if (existing) {
    return existing;
  }
  orders.push(order);
  orderStore.write(orders);
  return order;
};

const update = (order) => {
  const orders = getAll();
  const index = orders.findIndex((item) => item.id === order.id);
  if (index === -1) {
    return null;
  }
  orders[index] = { ...orders[index], ...order };
  orderStore.write(orders);
  return orders[index];
};

const removeById = (id) => {
  const orders = getAll();
  const filtered = orders.filter((order) => order.id !== id);
  if (filtered.length === orders.length) {
    return null;
  }
  orderStore.write(filtered);
  return id;
};

module.exports = {
  getAll,
  findById,
  findByUserId,
  findByUserIdAndIdempotencyKey,
  findByPaymentIntentId,
  insert,
  update,
  removeById,
};
