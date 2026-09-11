import {useEffect, useState} from "react";
import {BrowserExtension, Detail, LocalStorage, environment} from "@raycast/api";

export default function Command() {
  const [markdown, setMarkdown] = useState("Reading the browser fixture…");
  useEffect(() => {
    (async () => {
      if (!environment.canAccess(BrowserExtension)) throw new Error("Browser bridge is disconnected");
      const tabs = await BrowserExtension.getTabs();
      const tab = tabs.find(tab => tab.title === "Super Space Browser Fixture");
      if (!tab) throw new Error("Open the browser fixture first");
      const text = await BrowserExtension.getContent({tabId:tab.id,format:"text",cssSelector:"#sample"});
      const html = await BrowserExtension.getContent({tabId:tab.id,format:"html",cssSelector:"#sample"});
      const markdown = await BrowserExtension.getContent({tabId:tab.id,format:"markdown"});
      await LocalStorage.setItem("browser", {tab:tab.title,text,html,markdown});
      setMarkdown(`# Browser connected\n\n${markdown}\n\nText and HTML extraction also completed.`);
    })().catch((error: unknown) => setMarkdown(error instanceof Error ? error.message : String(error)));
  }, []);
  return <Detail markdown={markdown}/>;
}
