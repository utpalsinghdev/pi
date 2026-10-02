import type { Order } from "./orders.ts";
import { writeRecord } from "./storage.ts";

export async function persistOrder(order: Order): Promise<void> {
  await writeRecord("orders", order.id, order);
}
