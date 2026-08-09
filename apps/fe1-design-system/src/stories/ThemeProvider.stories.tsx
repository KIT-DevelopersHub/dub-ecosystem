import type { Meta, StoryObj } from "@storybook/react";
import { ThemeProvider, Button, Badge, Card } from "../index";

// ThemeProvider is a controlled theme boundary (凍結案 1-4-2). It stamps
// `data-theme` and inlines @dub/tokens CSS vars so a subtree can pin a theme
// regardless of the global toolbar selection.
const meta = {
  title: "Layout/ThemeProvider",
  component: ThemeProvider,
  tags: ["autodocs"],
  args: { theme: "light", children: null },
} satisfies Meta<typeof ThemeProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

function Sample() {
  return (
    <Card>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Button>Primary</Button>
        <Badge tone="brand">Badge</Badge>
        <span style={{ color: "var(--dub-color-text-secondary)" }}>surface text</span>
      </div>
    </Card>
  );
}

export const SideBySide: Story = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <ThemeProvider theme="light">
        <div style={{ background: "var(--dub-color-surface-base)", padding: 16, borderRadius: 8 }}>
          <p style={{ color: "var(--dub-color-text-primary)" }}>light</p>
          <Sample />
        </div>
      </ThemeProvider>
      <ThemeProvider theme="dark">
        <div style={{ background: "var(--dub-color-surface-base)", padding: 16, borderRadius: 8 }}>
          <p style={{ color: "var(--dub-color-text-primary)" }}>dark</p>
          <Sample />
        </div>
      </ThemeProvider>
    </div>
  ),
};
