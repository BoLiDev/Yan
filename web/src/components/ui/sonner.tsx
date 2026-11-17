"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// A toast is drawn light whatever the page's theme, so on a dark page it stands off it, white with its button
// black, rather than running into it; sonner's own light theme with it, whose description is dark. No line is
// drawn round one, its shadow lifting it off the page, and none has a button to close it: it is swiped away,
// to either side or off the edge it came from, or left to go.
const Toaster = (props: Omit<ToasterProps, "theme">) => {
  return (
    <Sonner
      theme="light"
      swipeDirections={['left', 'right', 'top', 'bottom']}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--toast-bg)",
          "--normal-text": "var(--toast-ink)",
          "--normal-border": "transparent",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // Its words are not selected by a drag over them: a toast taken by its words is being swiped off.
          toast: "cn-toast select-none",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
