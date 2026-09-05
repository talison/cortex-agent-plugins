import { test, expect } from "bun:test"

import { buildChannelMeta } from "../lib/channel-meta.ts"

test("channel meta includes reply_to_message_id when reply_to_message present", () => {
  const ctx = {
    chat: { id: 12345 },
    from: { id: 99, username: "tom" },
    message: {
      message_id: 200,
      date: 1714600000,
      reply_to_message: {
        message_id: 100,
        text: "Sharp drop: 104→69 in 30 min at 9:42 PM. Anything notable?",
      },
    },
  }
  const meta = buildChannelMeta(ctx)
  expect(meta.reply_to_message_id).toBe("100")
  expect(meta.reply_to_message_text).toContain("Sharp drop")
  expect(meta.message_id).toBe("200")
})

test("channel meta omits reply_to_* when no reply_to_message", () => {
  const ctx = {
    chat: { id: 12345 },
    from: { id: 99, username: "tom" },
    message: { message_id: 201, date: 1714600100 },
  }
  const meta = buildChannelMeta(ctx)
  expect(meta.reply_to_message_id).toBeUndefined()
  expect(meta.reply_to_message_text).toBeUndefined()
  expect(meta.message_id).toBe("201")
})

test("channel meta uses reply_to_message.caption when text is absent", () => {
  const ctx = {
    chat: { id: 12345 },
    from: { id: 99, username: "tom" },
    message: {
      message_id: 202,
      date: 1714600200,
      reply_to_message: {
        message_id: 100,
        caption: "Photo of dinner — pasta and wine",
      },
    },
  }
  const meta = buildChannelMeta(ctx)
  expect(meta.reply_to_message_id).toBe("100")
  expect(meta.reply_to_message_text).toBe("Photo of dinner — pasta and wine")
})
