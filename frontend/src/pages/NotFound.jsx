import { Link } from 'react-router-dom';
import { Empty } from '../components/ui.jsx';

export default function NotFound() {
  return (
    <Empty title="This page doesn't exist">
      Go back to the <Link to="/">overview</Link>.
    </Empty>
  );
}
