import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Form, FormField, TextField, Button } from "../index";

const meta = {
  title: "Form/Form",
  component: Form,
  tags: ["autodocs"],
  args: { onSubmit: () => {}, children: null },
} satisfies Meta<typeof Form>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    return (
      <Form onSubmit={() => {}}>
        <FormField label="名前" htmlFor="f-name" required help="表示名として使われます">
          <TextField id="f-name" value={name} onChange={setName} placeholder="山田 太郎" />
        </FormField>
        <FormField label="メール" htmlFor="f-email" error={email && !email.includes("@") ? "メール形式が不正です" : undefined}>
          <TextField id="f-email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" aria-describedby="f-email-error" />
        </FormField>
        <Button type="submit">送信</Button>
      </Form>
    );
  },
};

export const FieldWithError: StoryObj<typeof FormField> = {
  name: "FormField (error)",
  render: () => (
    <FormField label="URL" htmlFor="f-url" required error="有効な URL を入力してください" help="https:// から始めてください">
      <TextField id="f-url" type="url" value="notaurl" onChange={() => {}} invalid aria-describedby="f-url-error" />
    </FormField>
  ),
};
