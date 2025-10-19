const { orderStore } = require('../storage');

const getAll = () => orderStore.read();

const findById = (id) => getAll().find((order) => order.id === id) || null;

const findByUserId = (userId) => getAll().filter((order) => order.userId === userId);

const insert = (order) => {
  const orders = getAll();
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

module.exports = {
  getAll,
  findById,
  findByUserId,
  insert,
  update,
};
