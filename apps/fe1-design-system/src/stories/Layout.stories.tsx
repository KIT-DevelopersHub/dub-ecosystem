import type { Meta, StoryObj } from "@storybook/react";
import { AppShell, PageHeader, Stack, Grid, Card, Divider, Sidebar, Button, Badge } from "../index";

const meta = {
  title: "Layout/Layout",
  component: Card,
  tags: ["autodocs"],
  args: { children: null },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CardStory: Story = {
  name: "Card",
  render: () => (
    <Card header={<strong>カードヘッダー</strong>} footer={<Button>アクション</Button>}>
      <p>ヘッダー・本文・フッターを持つカード。</p>
    </Card>
  ),
};

export const StackStory: StoryObj<typeof Stack> = {
  name: "Stack",
  render: () => (
    <Stack direction="row" gap={3} align="center">
      <Badge tone="brand">A</Badge>
      <Badge tone="info">B</Badge>
      <Badge tone="success">C</Badge>
    </Stack>
  ),
};

export const GridStory: StoryObj<typeof Grid> = {
  name: "Grid",
  render: () => (
    <Grid columns={3} gap={3}>
      <Card>1</Card>
      <Card>2</Card>
      <Card>3</Card>
    </Grid>
  ),
};

export const DividerStory: StoryObj<typeof Divider> = {
  name: "Divider",
  render: () => (
    <div>
      <p>上</p>
      <Divider />
      <p>下</p>
    </div>
  ),
};

export const PageHeaderStory: StoryObj<typeof PageHeader> = {
  name: "PageHeader",
  render: () => (
    <PageHeader
      title="イベント一覧"
      description="開催予定のイベントを管理します"
      actions={<Button>新規作成</Button>}
    />
  ),
};

export const AppShellStory: StoryObj<typeof AppShell> = {
  name: "AppShell",
  render: () => (
    <div style={{ height: 420, border: "1px solid var(--dub-color-border-default)", borderRadius: 8, overflow: "hidden" }}>
      <AppShell
        header={<PageHeader title="DevHub" />}
        sidebar={
          <Sidebar
            activeId="home"
            items={[
              { id: "home", label: "ホーム", icon: "home" },
              { id: "events", label: "イベント", icon: "calendar", badgeCount: 3 },
              { id: "settings", label: "設定", icon: "settings" },
            ]}
          />
        }
      >
        <p>メインコンテンツ領域。</p>
      </AppShell>
    </div>
  ),
};
