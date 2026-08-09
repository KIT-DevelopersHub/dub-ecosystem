import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Pagination, LoadMore } from "../index";

const meta = {
  title: "Table/Pagination",
  component: Pagination,
  tags: ["autodocs"],
  args: { page: 1, pageSize: 20, totalCount: 0, onPageChange: () => {} },
} satisfies Meta<typeof Pagination>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [page, setPage] = useState(1);
    return <Pagination page={page} pageSize={20} totalCount={124} onPageChange={setPage} />;
  },
};

export const LoadMoreStory: StoryObj<typeof LoadMore> = {
  name: "LoadMore",
  render: () => {
    const [loading, setLoading] = useState(false);
    return (
      <LoadMore
        hasMore
        loading={loading}
        onLoadMore={() => {
          setLoading(true);
          setTimeout(() => setLoading(false), 800);
        }}
      />
    );
  },
};
