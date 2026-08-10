import type { Meta, StoryObj } from "@storybook/react";
import { RateLimitNotice } from "../index";

const meta = {
  title: "State/RateLimitNotice",
  component: RateLimitNotice,
  tags: ["autodocs"],
  args: { serviceLabel: "メール送信API", active: true },
} satisfies Meta<typeof RateLimitNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithEta: Story = {
  name: "回復見込みあり",
  args: { recoversAt: new Date(Date.now() + 8 * 60_000).toISOString() },
};

export const QuotaExhausted: Story = {
  name: "上限到達（ETAなし）",
  args: { recoversAt: null, tone: "danger" },
};
