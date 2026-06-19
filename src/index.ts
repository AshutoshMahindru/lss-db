import '@logseq/libs';
import './styles.css';
import { registerCommands } from './commands/register';

logseq.ready(registerCommands).catch(console.error);