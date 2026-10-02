import { createOrder, type Order } from "./orders.ts";

export function postOrder(order: Order): Promise<boolean> {
  return createOrder(order);
}
