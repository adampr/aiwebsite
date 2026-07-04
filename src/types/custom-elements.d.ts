import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      /** Canvas particle motes from the futurism design system (public/fx.js). */
      "xl-dust": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        density?: string;
        color?: string;
      };
    }
  }
}
