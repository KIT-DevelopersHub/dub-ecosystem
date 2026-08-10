// Per-widget dashboard frame (design 2-1). FE2 owns the HomeScreen frame; a
// feature-contributed HomeWidget body is mounted here inside an error boundary
// so one widget throwing never blanks the whole dashboard — the shell shows an
// in-frame fallback for that card only (mirrors useBffHome's per-frame partial
// policy: no global toast).
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";

interface Props {
  title: string;
  testId: string;
  children: ReactNode;
}
interface State {
  failed: boolean;
}

export class HomeWidgetFrame extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Widget-local failure; keep the rest of the dashboard alive. Logged (not
    // toasted) so a partial home render stays quiet, per design 2-1.
    console.error(`Home widget "${this.props.title}" failed to render`, error, info);
  }

  override render(): ReactNode {
    return (
      <section data-widget={this.props.testId}>
        <h2>{this.props.title}</h2>
        {this.state.failed ? (
          <p role="alert" data-testid={`${this.props.testId}-error`}>
            このウィジェットを表示できませんでした。
          </p>
        ) : (
          this.props.children
        )}
      </section>
    );
  }
}

/** Render a feature-contributed widget body inside its titled, isolated frame. */
export function renderHomeWidget(id: string, title: string, Body: ComponentType): JSX.Element {
  return (
    <HomeWidgetFrame key={id} title={title} testId={`home-widget-${id}`}>
      <Body />
    </HomeWidgetFrame>
  );
}
