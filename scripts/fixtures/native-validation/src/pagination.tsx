import {useState} from "react";
import {List, Grid, Action, ActionPanel, LocalStorage} from "@raycast/api";

export default function Command() {
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [layout, setLayout] = useState("list");
  const Root = layout === "list" ? List : Grid;
  const Item = layout === "list" ? List.Item : Grid.Item;
  async function load() {
    setLoading(true);
    await new Promise(resolve => setTimeout(resolve, 800));
    await LocalStorage.setItem(`pages-${layout}`, page + 1);
    setPage(page + 1);
    setLoading(false);
  }
  return <Root navigationTitle={`Pagination · ${layout} · page ${page}`} columns={3} isLoading={loading}
    pagination={{hasMore:page < 3, pageSize:12, onLoadMore:load}}
    searchBarAccessory={<List.Dropdown value={layout} onChange={value => {setLayout(value);setPage(1);}}>
      <List.Dropdown.Item title="List" value="list"/><List.Dropdown.Item title="Grid" value="grid"/>
    </List.Dropdown>}>
    {Array.from({length:page * 12}, (_, i) => <Item key={i} id={String(i)} title={`Item ${i + 1}`} content="📦" actions={<ActionPanel>
      <Action title="Record Item" onAction={() => LocalStorage.setItem(`page-item-${layout}`, i + 1)}/>
    </ActionPanel>}/>)}
  </Root>;
}
