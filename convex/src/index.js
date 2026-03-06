// index.js

class TextResponseRewriter {
  constructor(upstreamOrigin) {
    this.upstreamOrigin = upstreamOrigin;
  }

  // Function to rewrite HTML links
  rewriteHtmlLinks(html) {
    const rewriter = new HTMLRewriter().on("a", {
      element(element) {
        const href = element.getAttribute("href");
        if (href && href.startsWith("/")) {
          element.setAttribute("href", this.absolutizePath(href));
        }
      },
    });
    return rewriter.transform(html);
  }

  // Function to absolutize root-relative paths
  absolutizePath(path) {
    return `${this.upstreamOrigin}${path}`;
  }

  // Function to handle text responses with regex
  rewriteTextResponses(text) {
    // Regex to match root-relative paths
    const rootRelativePathRegex = /(?<=\s|\A)(\/[^\s]*)/g;

    return text.replace(rootRelativePathRegex, (match) => this.absolutizePath(match));
  }

  // Main function to rewrite responses
  rewriteResponse(response) {
    const contentType = response.headers.get("Content-Type");
    if (contentType && contentType.includes("text/html")) {
      return this.rewriteHtmlLinks(response);
    } else if (contentType && contentType.includes("text/")) {
      // For text content, exempt media/binary content
      return this.rewriteTextResponses(response);
    }
    return response; // Exempt binary/media content
  }
}

const upstreamOrigin = "https://your-upstream-origin.com"; // Replace with actual origin
const rewriter = new TextResponseRewriter(upstreamOrigin);

addEventListener("fetch", (event) => {
  event.respondWith(rewriter.rewriteResponse(event.request));
});