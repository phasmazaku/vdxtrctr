import { render, screen } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve([]),
  }));
});

test('renders the extractor form', () => {
  render(<App />);
  expect(screen.getByText(/Video URL Extractor/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Video page URL/i)).toBeInTheDocument();
});
