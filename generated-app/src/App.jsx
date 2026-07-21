import './App.css';

const App = () => {
    return (
        <div className="feedback-form">
            <h1>Your Feedback</h1>
            <form>
                <input type="email" placeholder="Email" required />
                <div className="rating">
                    <label>
                        <input type="radio" name="rating" value="1" /> 1
                    </label>
                    <label>
                        <input type="radio" name="rating" value="2" /> 2
                    </label>
                    <label>
                        <input type="radio" name="rating" value="3" /> 3
                    </label>
                    <label>
                        <input type="radio" name="rating" value="4" /> 4
                    </label>
                    <label>
                        <input type="radio" name="rating" value="5" /> 5
                    </label>
                </div>
                <textarea placeholder="Comments" rows="4" required></textarea>
                <button type="submit">Submit</button>
            </form>
        </div>
    );
};

export default App;