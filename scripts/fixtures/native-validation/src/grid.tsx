import {Grid, Image, Color, ActionPanel, Action, LocalStorage} from "@raycast/api";

export default function Command() {
  const actions = (id: string) => <ActionPanel><Action title="Select Item" onAction={() => LocalStorage.setItem("gridAction",id)}/></ActionPanel>;
  return <Grid columns={3} onSelectionChange={id => LocalStorage.setItem("gridSelection",id)} searchBarPlaceholder="Search validation items">
    <Grid.Section title="Shapes" subtitle="Two columns" columns={2}>
      <Grid.Item id="alpha" title="Alpha Circle" content={{source:"sample.png",mask:Image.Mask.Circle,tintColor:"#ff9e64"}} actions={actions("alpha")}/>
      <Grid.Item id="beta" title="Beta Triangle" content={{source:"sample.svg",tintColor:Color.Green}} actions={actions("beta")}/>
      <Grid.Item id="gamma" title="Gamma Emoji" content="🎄" actions={actions("gamma")}/>
    </Grid.Section>
    <Grid.Section title="Images" subtitle="One column" columns={1}>
      <Grid.Item id="delta" title="Delta Rounded" content={{source:"sample.png",mask:Image.Mask.RoundedRectangle}} actions={actions("delta")}/>
    </Grid.Section>
  </Grid>;
}
