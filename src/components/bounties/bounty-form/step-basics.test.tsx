// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepBasics, BasicsData } from "./step-basics";

// Mock shadcn/ui components
vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input data-testid={props["data-testid"] || "input"} {...props} />,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: any) => <textarea data-testid="textarea" {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: any) => (
    <div data-testid="select" data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: any) => (
    <div data-testid="select-trigger">{children}</div>
  ),
  SelectValue: () => <span data-testid="select-value" />,
  SelectContent: ({ children }: any) => (
    <div data-testid="select-content">{children}</div>
  ),
  SelectItem: ({ children, value, disabled }: any) => (
    <div data-testid={`select-item-${value}`} data-disabled={disabled}>
      {children}
    </div>
  ),
}));

// Mock PmImportDialog
vi.mock("@/components/bounties/pm-import-dialog", () => ({
  PmImportDialog: ({ children }: any) => (
    <div data-testid="pm-import-dialog">{children}</div>
  ),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Import: (props: any) => <svg data-testid="import-icon" {...props} />,
}));

const defaultData: BasicsData = {
  title: "",
  description: "",
  reward: 0,
  rewardCurrency: "USD",
};

describe("StepBasics", () => {
  it("renders title and description inputs", () => {
    const onChange = vi.fn();
    render(<StepBasics data={defaultData} onChange={onChange} />);

    const titleInput = screen.getByPlaceholderText(
      "e.g., Add rate limiting to the public API"
    );
    expect(titleInput).toBeInTheDocument();

    const descriptionTextarea = screen.getByPlaceholderText(
      "Explain the problem, what done looks like, and anything the solver should avoid..."
    );
    expect(descriptionTextarea).toBeInTheDocument();
  });

  it("calls onChange when title changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StepBasics data={defaultData} onChange={onChange} />);

    const titleInput = screen.getByPlaceholderText(
      "e.g., Add rate limiting to the public API"
    );
    await user.type(titleInput, "A");

    expect(onChange).toHaveBeenCalledWith({
      ...defaultData,
      title: "A",
    });
  });

  it("shows fee breakdown when reward is set", () => {
    const onChange = vi.fn();
    const dataWithReward: BasicsData = {
      ...defaultData,
      reward: 100,
      rewardCurrency: "USD",
    };
    render(<StepBasics data={dataWithReward} onChange={onChange} />);

    // "You pay" row
    expect(screen.getByText("Reward held in escrow")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();

    // Platform fee row - 8% of 100 = 8.00
    expect(screen.getByText(/Platform fee/)).toBeInTheDocument();
    expect(screen.getByText("-$8.00")).toBeInTheDocument();

    // Solver receives row - 100 - 8 = 92.00
    expect(screen.getByText("Estimated solver payout")).toBeInTheDocument();
    expect(screen.getByText("$92.00")).toBeInTheDocument();
  });

  it("hides fee breakdown when reward is 0", () => {
    const onChange = vi.fn();
    render(<StepBasics data={defaultData} onChange={onChange} />);

    expect(screen.queryByText("Reward held in escrow")).not.toBeInTheDocument();
    expect(screen.queryByText("Estimated solver payout")).not.toBeInTheDocument();
    expect(screen.queryByText(/Platform fee/)).not.toBeInTheDocument();
  });

  it("renders currency options", () => {
    const onChange = vi.fn();
    render(<StepBasics data={defaultData} onChange={onChange} />);

    // USD should be available
    const usdItem = screen.getByTestId("select-item-USD");
    expect(usdItem).toBeInTheDocument();
    expect(usdItem).toHaveTextContent("USD");

    // ETH and USDC should be rendered but disabled
    const ethItem = screen.getByTestId("select-item-ETH");
    expect(ethItem).toBeInTheDocument();
    expect(ethItem).toHaveAttribute("data-disabled", "true");

    const usdcItem = screen.getByTestId("select-item-USDC");
    expect(usdcItem).toBeInTheDocument();
    expect(usdcItem).toHaveAttribute("data-disabled", "true");
  });
});
