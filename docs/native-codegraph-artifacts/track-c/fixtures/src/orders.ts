import { persistOrder } from "./persistence.ts";
import { notifyOrder } from "./notifier.ts";

export interface Order {
  id: string;
  customerId: string;
}

export function validateOrder(order: Order): boolean {
  return order.id.length > 0 && order.customerId.length > 0;
}

export async function createOrder(order: Order): Promise<boolean> {
  if (!validateOrder(order)) return false;
  await persistOrder(order);
  notifyOrder(order.id);
  return true;
}
