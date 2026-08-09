import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { TextField, Textarea, Select, Checkbox, Radio, Switch, DatePicker } from "../index";

const meta = {
  title: "Form/Inputs",
  component: TextField,
  tags: ["autodocs"],
  args: { id: "s-text", value: "", onChange: () => {} },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TextFieldStory: Story = {
  name: "TextField",
  render: () => {
    const [v, setV] = useState("");
    return <TextField id="s-text" value={v} onChange={setV} placeholder="入力してください" />;
  },
};

export const TextareaStory: StoryObj<typeof Textarea> = {
  name: "Textarea",
  render: () => {
    const [v, setV] = useState("");
    return <Textarea id="s-textarea" value={v} onChange={setV} rows={4} placeholder="複数行のメモ" />;
  },
};

export const SelectStory: StoryObj<typeof Select> = {
  name: "Select",
  render: () => {
    const [v, setV] = useState<string | null>(null);
    return (
      <Select
        id="s-select"
        value={v}
        onChange={setV}
        placeholder="選択してください"
        options={[
          { value: "todo", label: "未着手" },
          { value: "doing", label: "進行中" },
          { value: "done", label: "完了" },
          { value: "archived", label: "アーカイブ", disabled: true },
        ]}
      />
    );
  },
};

export const CheckboxStory: StoryObj<typeof Checkbox> = {
  name: "Checkbox",
  render: () => {
    const [c, setC] = useState(true);
    return <Checkbox id="s-check" checked={c} onChange={setC} label="通知を受け取る" />;
  },
};

export const RadioStory: StoryObj<typeof Radio> = {
  name: "Radio",
  render: () => {
    const [v, setV] = useState("email");
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Radio id="r-email" name="channel" value="email" checked={v === "email"} onChange={setV} label="メール" />
        <Radio id="r-slack" name="channel" value="slack" checked={v === "slack"} onChange={setV} label="Slack" />
        <Radio id="r-none" name="channel" value="none" checked={v === "none"} onChange={setV} label="通知なし" />
      </div>
    );
  },
};

export const SwitchStory: StoryObj<typeof Switch> = {
  name: "Switch",
  render: () => {
    const [on, setOn] = useState(false);
    return <Switch id="s-switch" checked={on} onChange={setOn} label="ダークモード" />;
  },
};

export const DatePickerStory: StoryObj<typeof DatePicker> = {
  name: "DatePicker",
  render: () => {
    const [d, setD] = useState<string | null>("2026-08-09");
    return <DatePicker id="s-date" value={d} onChange={setD} />;
  },
};
